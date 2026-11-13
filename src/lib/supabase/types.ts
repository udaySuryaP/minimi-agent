// src/lib/supabase/types.ts
// Database type definitions — mirrors the SQL schema.
// Regenerate from Supabase CLI: `supabase gen types typescript --local > src/lib/supabase/types.ts`

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          display_name: string | null
          timezone: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          display_name?: string | null
          timezone?: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          display_name?: string | null
          timezone?: string
          created_at?: string
          updated_at?: string
        }
      }
      conversations: {
        Row: {
          id: string
          user_id: string
          title: string
          summary: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          title?: string
          summary?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          summary?: string | null
          created_at?: string
          updated_at?: string
        }
      }
      messages: {
        Row: {
          id: string
          conversation_id: string
          user_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          conversation_id: string
          user_id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          conversation_id?: string
          user_id?: string
          role?: 'user' | 'assistant' | 'system'
          content?: string
          metadata?: Json
          created_at?: string
        }
      }
      memory_items: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          message_id: string | null
          entity_type: 'product' | 'company' | 'decision' | 'fact' | 'preference' | 'topic' | 'other'
          entity_name: string
          content: string
          metadata: Json
          valid_from: string | null
          valid_to: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          conversation_id: string
          message_id?: string | null
          entity_type: 'product' | 'company' | 'decision' | 'fact' | 'preference' | 'topic' | 'other'
          entity_name: string
          content: string
          metadata?: Json
          valid_from?: string | null
          valid_to?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          message_id?: string | null
          entity_type?: 'product' | 'company' | 'decision' | 'fact' | 'preference' | 'topic' | 'other'
          entity_name?: string
          content?: string
          metadata?: Json
          valid_from?: string | null
          valid_to?: string | null
          created_at?: string
        }
      }
      research_snapshots: {
        Row: {
          id: string
          user_id: string
          conversation_id: string
          trigger_message_id: string | null
          query: string
          status: 'pending' | 'completed' | 'failed' | 'partial'
          search_params: Json
          created_at: string
          completed_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          conversation_id: string
          trigger_message_id?: string | null
          query: string
          status?: 'pending' | 'completed' | 'failed' | 'partial'
          search_params?: Json
          created_at?: string
          completed_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          conversation_id?: string
          trigger_message_id?: string | null
          query?: string
          status?: 'pending' | 'completed' | 'failed' | 'partial'
          search_params?: Json
          created_at?: string
          completed_at?: string | null
        }
      }
      research_claims: {
        Row: {
          id: string
          snapshot_id: string
          entity_name: string
          claim_type: 'pricing' | 'feature' | 'announcement' | 'comparison' | 'general'
          claim_text: string
          claim_value: string | null
          structured_data: Json
          valid_at: string | null
          recorded_at: string
        }
        Insert: {
          id?: string
          snapshot_id: string
          entity_name: string
          claim_type: 'pricing' | 'feature' | 'announcement' | 'comparison' | 'general'
          claim_text: string
          claim_value?: string | null
          structured_data?: Json
          valid_at?: string | null
          recorded_at?: string
        }
        Update: {
          id?: string
          snapshot_id?: string
          entity_name?: string
          claim_type?: 'pricing' | 'feature' | 'announcement' | 'comparison' | 'general'
          claim_text?: string
          claim_value?: string | null
          structured_data?: Json
          valid_at?: string | null
          recorded_at?: string
        }
      }
      research_sources: {
        Row: {
          id: string
          claim_id: string
          url: string
          title: string | null
          snippet: string | null
          domain: string | null
          score: number | null
          published_at: string | null
          retrieved_at: string
        }
        Insert: {
          id?: string
          claim_id: string
          url: string
          title?: string | null
          snippet?: string | null
          domain?: string | null
          score?: number | null
          published_at?: string | null
          retrieved_at?: string
        }
        Update: {
          id?: string
          claim_id?: string
          url?: string
          title?: string | null
          snippet?: string | null
          domain?: string | null
          score?: number | null
          published_at?: string | null
          retrieved_at?: string
        }
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']

export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert']

export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update']
