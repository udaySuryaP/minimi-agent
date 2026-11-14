export const DEFAULT_MAX_AGENT_REQUEST_BYTES = 16 * 1024
const HARD_MAX_AGENT_REQUEST_BYTES = 1024 * 1024

export function getMaxAgentRequestBytes(value = process.env.AGENT_MAX_REQUEST_BYTES): number {
  const normalized = value?.trim()
  if (!normalized || !/^\d+$/.test(normalized)) return DEFAULT_MAX_AGENT_REQUEST_BYTES
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= HARD_MAX_AGENT_REQUEST_BYTES
    ? parsed
    : DEFAULT_MAX_AGENT_REQUEST_BYTES
}

export type RequestBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_json' | 'read_failed' }

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel() } catch { /* The request may already have been aborted. */ }
}

export async function readAgentRequestBody(request: Request, maxBytes = getMaxAgentRequestBytes()): Promise<RequestBodyResult> {
  if (!request.body) return { ok: false, reason: 'invalid_json' }
  const reader = request.body.getReader()
  const lengthHeader = request.headers.get('content-length')
  const declaredLength = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    if (declaredLength !== null && Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      await cancelReader(reader)
      return { ok: false, reason: 'too_large' }
    }

    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await cancelReader(reader)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(chunk.value)
    }

    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    } catch {
      return { ok: false, reason: 'invalid_json' }
    }
  } catch {
    await cancelReader(reader)
    return { ok: false, reason: 'read_failed' }
  } finally {
    try { reader.releaseLock() } catch { /* Cancellation or an abort can release the reader first. */ }
  }
}
