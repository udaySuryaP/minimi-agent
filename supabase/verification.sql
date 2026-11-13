-- supabase/verification.sql
-- Comprehensive Verification Script for Minimi Phase 1 Database Integrity, Immutability & RLS
--
-- TARGET ENVIRONMENT & ELEVATED PRIVILEGES:
-- - This script is designed for execution in the Supabase Dashboard SQL Editor
--   or via local PostgreSQL / Supabase CLI (`supabase db query`) where administrative
--   privileges (postgres / service_role) are available.
-- - Administrative privileges are required because this script creates ephemeral
--   test identities in `auth.users` to satisfy foreign-key constraints on `public.profiles`.
-- - It is strictly a validation harness; client applications never access `auth.users` directly.
-- - The entire verification runs inside an atomic transaction and unconditionally rolls
--   back at the end (ROLLBACK). No test data, credentials, or mock accounts are persisted.
--
-- TEST SCENARIOS COVERED:
-- [Part 1: Snapshot Finalization & Immutability Integrity - Narrow SQLSTATE/Message Checks]
-- 1. Ephemeral auth user & profile creation.
-- 2. Pending snapshot creation, claim attachment, and source attachment.
-- 3. Finalization integrity: attempting to finalize with conversation_id = NULL (must fail with P0001).
-- 4. Finalization integrity: attempting invalid status transition (must fail with 23514 or P0001).
-- 5. Normal finalization with valid conversation (must succeed).
-- 6. Research snapshot immutability: direct UPDATE of content/query (must fail with P0001).
-- 7. Research snapshot immutability: direct DELETE of finalized snapshot while profile exists (must fail with P0001).
-- 8. Research claim immutability: INSERT against finalized snapshot (must fail with P0001).
-- 9. Research claim immutability: UPDATE on claim of finalized snapshot (must fail with P0001).
-- 10. Research claim immutability: DELETE on claim of finalized snapshot (must fail with P0001).
-- 11. Research source immutability: INSERT against finalized snapshot (must fail with P0001).
-- 12. Research source immutability: UPDATE on source of finalized snapshot (must fail with P0001).
-- 13. Research source immutability: DELETE on source of finalized snapshot (must fail with P0001).
--
-- [Part 2: Referential Cleanup on Message & Conversation Deletion]
-- 14. Referential cleanup: deleting trigger message sets trigger_message_id to NULL.
-- 15. Referential cleanup: deleting conversation sets conversation_id to NULL.
-- 16. Preservation of research evidence: snapshot, claims, and sources remain intact.
--
-- [Part 3: Authenticated-Role Row Level Security (RLS) Verification]
-- 17. Authenticated role: User A can read their own permitted records.
-- 18. Authenticated role: User A cannot read User B's protected records (RLS row filtering).
-- 19. Authenticated role: User A cannot mutate (UPDATE/DELETE) User B's records (0 rows affected).
-- 20. Authenticated role: User A cannot mutate their own finalized snapshot (0 rows affected).
--
-- [Part 4: Complete Account-Deletion Cascade from auth.users]
-- 21. Account deletion cascade: deleting user from auth.users purges all dependent rows
--     across profiles, conversations, messages, memory_items, snapshots, claims, and sources.

begin;

do $$
declare
  v_user_a_id uuid := gen_random_uuid();
  v_user_b_id uuid := gen_random_uuid();
  v_email_a text;
  v_email_b text;
  v_conv_a_id uuid;
  v_conv_b_id uuid;
  v_msg_a_id uuid;
  v_msg_b_id uuid;
  v_mem_b_id uuid;
  v_snap_a_id uuid;
  v_snap_b_id uuid;
  v_claim_a_id uuid;
  v_claim_b_id uuid;
  v_source_a_id uuid;
  v_source_b_id uuid;
  v_trigger_ref uuid;
  v_conv_ref uuid;
  v_cnt int;
  v_rows_affected int;
  v_caught boolean;
  v_sqlstate text;
  v_err_msg text;
begin
  raise notice '============================================================';
  raise notice 'Starting Minimi Phase 1 Comprehensive Database Verification';
  raise notice '============================================================';

  v_email_a := 'test-verifier-a-' || replace(v_user_a_id::text, '-', '') || '@example.test';
  v_email_b := 'test-verifier-b-' || replace(v_user_b_id::text, '-', '') || '@example.test';

  -- --------------------------------------------------------------------------
  -- Setup: Create Test User A and User B in auth.users
  -- --------------------------------------------------------------------------
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values
  (
    v_user_a_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_email_a, 'test-hash-a', now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('display_name', 'User A', 'timezone', 'Asia/Kolkata'),
    now(), now()
  ),
  (
    v_user_b_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    v_email_b, 'test-hash-b', now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('display_name', 'User B', 'timezone', 'UTC'),
    now(), now()
  );

  -- Ensure matching profiles exist in public.profiles (trigger or direct insert)
  insert into public.profiles (id, display_name, timezone)
  values
    (v_user_a_id, 'User A', 'Asia/Kolkata'),
    (v_user_b_id, 'User B', 'UTC')
  on conflict (id) do nothing;

  raise notice 'PASSED [Setup]: Ephemeral test users and profiles initialized.';

  -- Setup User A fixtures
  insert into public.conversations (user_id, title)
  values (v_user_a_id, 'CRM Research 2026')
  returning id into v_conv_a_id;

  insert into public.messages (conversation_id, user_id, role, content)
  values (v_conv_a_id, v_user_a_id, 'user', 'Shortlist 5 CRM tools')
  returning id into v_msg_a_id;

  insert into public.research_snapshots (user_id, conversation_id, trigger_message_id, query, status)
  values (v_user_a_id, v_conv_a_id, v_msg_a_id, 'CRM tools pricing 20-person sales team', 'pending')
  returning id into v_snap_a_id;

  insert into public.research_claims (snapshot_id, entity_name, claim_type, claim_text, claim_value)
  values (v_snap_a_id, 'HubSpot', 'pricing', 'HubSpot Sales Hub Professional starts at $90/seat/month', '$90')
  returning id into v_claim_a_id;

  insert into public.research_sources (claim_id, url, title, snippet)
  values (v_claim_a_id, 'https://example.com/hubspot-pricing', 'HubSpot Pricing 2026', 'Official pricing details')
  returning id into v_source_a_id;

  -- Setup User B fixtures
  insert into public.conversations (user_id, title)
  values (v_user_b_id, 'Postgres Hosting 2026')
  returning id into v_conv_b_id;

  insert into public.messages (conversation_id, user_id, role, content)
  values (v_conv_b_id, v_user_b_id, 'user', 'Compare Supabase and RDS')
  returning id into v_msg_b_id;

  insert into public.memory_items (user_id, conversation_id, message_id, entity_type, entity_name, content)
  values (v_user_b_id, v_conv_b_id, v_msg_b_id, 'product', 'Supabase', 'User interested in managed Postgres hosting')
  returning id into v_mem_b_id;

  insert into public.research_snapshots (user_id, conversation_id, trigger_message_id, query, status)
  values (v_user_b_id, v_conv_b_id, v_msg_b_id, 'Postgres hosting pricing comparison', 'pending')
  returning id into v_snap_b_id;

  insert into public.research_claims (snapshot_id, entity_name, claim_type, claim_text, claim_value)
  values (v_snap_b_id, 'Supabase', 'pricing', 'Pro plan starts at $25/month', '$25')
  returning id into v_claim_b_id;

  insert into public.research_sources (claim_id, url, title, snippet)
  values (v_claim_b_id, 'https://example.com/supabase-pricing', 'Supabase Pricing', 'Pro plan pricing')
  returning id into v_source_b_id;

  -- ==========================================================================
  -- PART 1: Snapshot Finalization & Immutability Integrity (Specific Errors)
  -- ==========================================================================

  -- Test 1: Finalizing snapshot with conversation_id = NULL must fail (P0001)
  v_caught := false;
  begin
    update public.research_snapshots
    set status = 'completed', completed_at = now(), conversation_id = null
    where id = v_snap_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Finalized research snapshot must retain a valid conversation reference%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 1]: Expected P0001 / conversation reference error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 1]: Finalizing snapshot with NULL conversation_id did not fail as expected!';
  end if;
  raise notice 'PASSED [Test 1]: Finalizing snapshot with NULL conversation_id rejected with specific P0001 exception.';

  -- Test 2: Invalid status transition must fail (23514 or P0001)
  v_caught := false;
  begin
    update public.research_snapshots
    set status = 'invalid_status'
    where id = v_snap_a_id;
  exception
    when check_violation then
      get stacked diagnostics v_sqlstate = returned_sqlstate;
      if v_sqlstate = '23514' then
        v_caught := true;
      end if;
    when raise_exception then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
      if v_sqlstate = 'P0001' and v_err_msg like '%Invalid snapshot status transition%' then
        v_caught := true;
      end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 2]: Invalid status transition did not fail as expected!';
  end if;
  raise notice 'PASSED [Test 2]: Invalid status transition rejected with specific check_violation / P0001.';

  -- Test 3: Normal finalization with valid conversation MUST SUCCEED
  update public.research_snapshots
  set status = 'completed', completed_at = now()
  where id = v_snap_a_id;

  update public.research_snapshots
  set status = 'completed', completed_at = now()
  where id = v_snap_b_id;

  raise notice 'PASSED [Test 3]: Normal snapshot finalization succeeded.';

  -- Test 4: Direct UPDATE on finalized snapshot query must fail (P0001)
  v_caught := false;
  begin
    update public.research_snapshots
    set query = 'Tampered query text'
    where id = v_snap_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Completed or finalized research snapshots are immutable%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 4]: Expected P0001 immutable error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 4]: Direct UPDATE on finalized snapshot query did not fail!';
  end if;
  raise notice 'PASSED [Test 4]: Direct UPDATE on finalized snapshot query rejected with P0001.';

  -- Test 5: Direct DELETE of finalized snapshot while profile exists must fail (P0001)
  v_caught := false;
  begin
    delete from public.research_snapshots
    where id = v_snap_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Completed or finalized research snapshots cannot be deleted while user profile exists%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 5]: Expected P0001 cannot-delete error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 5]: Direct DELETE of finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 5]: Direct DELETE of finalized snapshot rejected with P0001.';

  -- Test 6: INSERT claim against finalized snapshot must fail (P0001)
  v_caught := false;
  begin
    insert into public.research_claims (snapshot_id, entity_name, claim_type, claim_text)
    values (v_snap_a_id, 'Pipedrive', 'pricing', 'New claim attempt');
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Cannot add, modify, or delete claims or sources for a finalized research snapshot%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 6]: Expected P0001 claims-immutability error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 6]: INSERT claim on finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 6]: INSERT claim on finalized snapshot rejected with P0001.';

  -- Test 7: UPDATE claim belonging to finalized snapshot must fail (P0001)
  v_caught := false;
  begin
    update public.research_claims
    set claim_text = 'Tampered claim text'
    where id = v_claim_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Cannot add, modify, or delete claims or sources for a finalized research snapshot%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 7]: Expected P0001 claims-immutability error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 7]: UPDATE claim on finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 7]: UPDATE claim on finalized snapshot rejected with P0001.';

  -- Test 8: DELETE claim belonging to finalized snapshot must fail (P0001)
  v_caught := false;
  begin
    delete from public.research_claims
    where id = v_claim_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Cannot add, modify, or delete claims or sources for a finalized research snapshot%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 8]: Expected P0001 claims-immutability error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 8]: DELETE claim on finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 8]: DELETE claim on finalized snapshot rejected with P0001.';

  -- Test 9: INSERT source against finalized snapshot must fail (P0001)
  v_caught := false;
  begin
    insert into public.research_sources (claim_id, url, title)
    values (v_claim_a_id, 'https://example.com/new-source', 'New Source Attempt');
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Cannot add, modify, or delete claims or sources for a finalized research snapshot%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 9]: Expected P0001 sources-immutability error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 9]: INSERT source on finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 9]: INSERT source on finalized snapshot rejected with P0001.';

  -- Test 10: UPDATE source belonging to finalized snapshot must fail (P0001)
  v_caught := false;
  begin
    update public.research_sources
    set snippet = 'Tampered source snippet'
    where id = v_source_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Cannot add, modify, or delete claims or sources for a finalized research snapshot%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 10]: Expected P0001 sources-immutability error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 10]: UPDATE source on finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 10]: UPDATE source on finalized snapshot rejected with P0001.';

  -- Test 11: DELETE source belonging to finalized snapshot must fail (P0001)
  v_caught := false;
  begin
    delete from public.research_sources
    where id = v_source_a_id;
  exception when raise_exception then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_err_msg = message_text;
    if v_sqlstate = 'P0001' and v_err_msg like '%Cannot add, modify, or delete claims or sources for a finalized research snapshot%' then
      v_caught := true;
    else
      raise exception 'FAILED [Test 11]: Expected P0001 sources-immutability error, got [%] %', v_sqlstate, v_err_msg;
    end if;
  end;
  if not v_caught then
    raise exception 'FAILED [Test 11]: DELETE source on finalized snapshot did not fail!';
  end if;
  raise notice 'PASSED [Test 11]: DELETE source on finalized snapshot rejected with P0001.';

  -- ==========================================================================
  -- PART 2: Referential Cleanup on Message & Conversation Deletion
  -- ==========================================================================

  -- Test 12: Delete trigger message sets trigger_message_id to NULL
  delete from public.messages where id = v_msg_a_id;

  select trigger_message_id into v_trigger_ref
  from public.research_snapshots
  where id = v_snap_a_id;

  if v_trigger_ref is not null then
    raise exception 'FAILED [Test 12]: trigger_message_id was not set to NULL after message deletion!';
  end if;
  raise notice 'PASSED [Test 12]: Deleting message cleanly set trigger_message_id to NULL.';

  -- Test 13: Delete conversation sets conversation_id to NULL
  delete from public.conversations where id = v_conv_a_id;

  select conversation_id into v_conv_ref
  from public.research_snapshots
  where id = v_snap_a_id;

  if v_conv_ref is not null then
    raise exception 'FAILED [Test 13]: conversation_id was not set to NULL after conversation deletion!';
  end if;
  raise notice 'PASSED [Test 13]: Deleting conversation cleanly set conversation_id to NULL.';

  -- Test 14: Historical evidence preservation
  select count(*) into v_cnt
  from public.research_claims
  where snapshot_id = v_snap_a_id;

  if v_cnt <> 1 then
    raise exception 'FAILED [Test 14]: Research claims lost after conversation deletion!';
  end if;

  select count(*) into v_cnt
  from public.research_sources
  where claim_id = v_claim_a_id;

  if v_cnt <> 1 then
    raise exception 'FAILED [Test 14]: Research sources lost after conversation deletion!';
  end if;
  raise notice 'PASSED [Test 14]: Historical research snapshot, claims, and sources intact.';

  -- ==========================================================================
  -- PART 3: Authenticated-Role Row Level Security (RLS) Verification
  -- ==========================================================================
  -- Simulate standard Supabase client execution by switching role to 'authenticated'
  -- and setting the JWT context for User A.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_a_id::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_user_a_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- Test 15: User A can read their own permitted records under RLS
  select count(*) into v_cnt from public.profiles where id = v_user_a_id;
  if v_cnt <> 1 then
    raise exception 'FAILED [Test 15]: RLS prevented User A from reading own profile!';
  end if;

  select count(*) into v_cnt from public.research_snapshots where id = v_snap_a_id;
  if v_cnt <> 1 then
    raise exception 'FAILED [Test 15]: RLS prevented User A from reading own research snapshot!';
  end if;

  select count(*) into v_cnt from public.research_claims where id = v_claim_a_id;
  if v_cnt <> 1 then
    raise exception 'FAILED [Test 15]: RLS prevented User A from reading own research claims!';
  end if;
  raise notice 'PASSED [Test 15]: Authenticated role verified: User A can read own permitted records.';

  -- Test 16: User A cannot read User B protected records under RLS (Tenant Isolation)
  select count(*) into v_cnt from public.conversations where id = v_conv_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 16]: RLS leaked User B conversation to User A!';
  end if;

  select count(*) into v_cnt from public.messages where id = v_msg_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 16]: RLS leaked User B message to User A!';
  end if;

  select count(*) into v_cnt from public.memory_items where id = v_mem_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 16]: RLS leaked User B memory item to User A!';
  end if;

  select count(*) into v_cnt from public.research_snapshots where id = v_snap_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 16]: RLS leaked User B research snapshot to User A!';
  end if;
  raise notice 'PASSED [Test 16]: Authenticated role verified: User A cannot read User B records.';

  -- Test 17: User A cannot mutate (UPDATE or DELETE) User B records under RLS
  update public.conversations
  set title = 'Hacked Title'
  where id = v_conv_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected <> 0 then
    raise exception 'FAILED [Test 17]: RLS permitted User A to UPDATE User B conversation!';
  end if;

  delete from public.conversations
  where id = v_conv_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected <> 0 then
    raise exception 'FAILED [Test 17]: RLS permitted User A to DELETE User B conversation!';
  end if;
  raise notice 'PASSED [Test 17]: Authenticated role verified: User A cannot UPDATE or DELETE User B records.';

  -- Test 18: User A cannot mutate their own finalized snapshot under RLS
  update public.research_snapshots
  set query = 'Client side tamper attempt'
  where id = v_snap_a_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected <> 0 then
    raise exception 'FAILED [Test 18]: RLS permitted User A to UPDATE completed snapshot!';
  end if;

  delete from public.research_snapshots
  where id = v_snap_a_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected <> 0 then
    raise exception 'FAILED [Test 18]: RLS permitted User A to DELETE completed snapshot!';
  end if;
  raise notice 'PASSED [Test 18]: Authenticated role verified: User A cannot UPDATE or DELETE completed snapshot.';

  -- Safely restore role back to postgres for remaining administrative cleanup assertions
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);

  -- ==========================================================================
  -- PART 4: Complete Account-Deletion Cascade from auth.users
  -- ==========================================================================
  -- Delete User B from auth.users. The cascade MUST delete profiles, conversations,
  -- messages, memory_items, research_snapshots, research_claims, and research_sources.
  delete from auth.users where id = v_user_b_id;

  -- Assert absence across all tables
  select count(*) into v_cnt from auth.users where id = v_user_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B remains in auth.users!';
  end if;

  select count(*) into v_cnt from public.profiles where id = v_user_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B profile remains in public.profiles!';
  end if;

  select count(*) into v_cnt from public.conversations where user_id = v_user_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B conversations remain!';
  end if;

  select count(*) into v_cnt from public.messages where user_id = v_user_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B messages remain!';
  end if;

  select count(*) into v_cnt from public.memory_items where user_id = v_user_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B memory_items remain!';
  end if;

  select count(*) into v_cnt from public.research_snapshots where user_id = v_user_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B research_snapshots remain!';
  end if;

  select count(*) into v_cnt from public.research_claims where snapshot_id = v_snap_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B research_claims remain!';
  end if;

  select count(*) into v_cnt from public.research_sources where claim_id = v_claim_b_id;
  if v_cnt <> 0 then
    raise exception 'FAILED [Test 19]: User B research_sources remain!';
  end if;

  raise notice 'PASSED [Test 19]: Complete account deletion cascade from auth.users verified across all tables.';

  raise notice '============================================================';
  raise notice 'ALL VERIFICATION SUITE TESTS PASSED SUCCESSFULLY!';
  raise notice '============================================================';
end;
$$;

rollback;
