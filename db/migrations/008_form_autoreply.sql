-- 008: an optional confirmation email to the person who submitted a form.
--
-- Why this is the risky feature on the list: it sends mail to an address a
-- stranger typed into a public form. That is the shape of an open relay, so
-- the controls are in the schema rather than only in application code:
--
--   * the message is written by the form's OWNER when they create the form,
--     stored here, and never taken from the request;
--   * plain text only, 500 characters, so it cannot carry markup or a payload;
--   * one confirmation per address per form per hour, enforced below, so the
--     same address cannot be used to amplify a message at someone.
--
-- Safe to re-run. Existing forms have reply_enabled false: nothing starts
-- sending because this migration ran.

alter table native_forms add column if not exists reply_enabled boolean not null default false;
alter table native_forms add column if not exists reply_subject text;
alter table native_forms add column if not exists reply_body text;
alter table native_form_submissions add column if not exists reply_status text
  check (reply_status is null or reply_status in ('pending', 'sent', 'failed', 'suppressed'));

-- Returns true when a confirmation to this address is allowed right now.
-- Counted against submissions rather than a separate log: a submission is the
-- only thing that can cause one, so it is the honest place to count.
create or replace function public.may_send_form_reply(p_form uuid, p_email text, p_submission uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare recent int;
begin
  perform pg_advisory_xact_lock(hashtextextended('form-reply:' || p_form::text, 0));
  select count(*) into recent
    from native_form_submissions s
   where s.form_id = p_form
     and s.id <> p_submission
     and s.reply_status in ('sent', 'pending')
     and lower(s.data->>'email') = lower(p_email)
     and s.created_at > now() - interval '1 hour';
  if recent > 0 then
    update native_form_submissions set reply_status = 'suppressed' where id = p_submission;
    return false;
  end if;
  update native_form_submissions set reply_status = 'pending' where id = p_submission;
  return true;
end $$;

revoke all on function public.may_send_form_reply(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.may_send_form_reply(uuid, text, uuid) to service_role;

-- submit_native_form gains the confirmation fields. Same body as 005 otherwise:
-- limits, locking and the shared/paused checks are unchanged.
create or replace function public.submit_native_form(p_form uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare f public.native_forms; sid uuid;
begin
  select * into f from native_forms where id = p_form;
  if not found then raise exception 'form_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('native-forms:' || f.owner_id::text, 0));
  select * into f from native_forms where id = p_form for update;
  if not found or not f.enabled then raise exception 'form_unavailable'; end if;
  if jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 16000 then raise exception 'invalid_data'; end if;
  if (select count(*) from native_form_submissions where form_id = p_form and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'rate_limit';
  end if;
  if (select count(*) from native_form_submissions where owner_id = f.owner_id and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC') >= 300
    or (select count(*) from native_form_submissions where owner_id = f.owner_id) >= 1000 then
    raise exception 'submission_limit';
  end if;
  insert into native_form_submissions(form_id, owner_id, data, notification_status)
    values(f.id, f.owner_id, p_data, case when f.notify then 'pending' else 'disabled' end) returning id into sid;
  return jsonb_build_object(
    'id', sid, 'notify', f.notify, 'email', f.notification_email, 'name', f.name,
    'replyEnabled', f.reply_enabled, 'replySubject', f.reply_subject, 'replyBody', f.reply_body
  );
end $$;
revoke all on function public.submit_native_form(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.submit_native_form(uuid,jsonb) to service_role;
