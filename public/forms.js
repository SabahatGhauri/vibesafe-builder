/* Native forms are account-owned; no submission data is sent to an LLM. */
(() => {
  const byId = id => document.getElementById(id);
  const endpoint = id => `${location.origin}/api/forms/public/${id}/submit`;
  let selected = null;
  let forms = [];
  let inboxRequest = 0;
  const status = message => { byId('nativeFormStatus').textContent = message; };
  async function api(path, opts = {}) {
    const r = await fetch(`/api/forms${path}`,{...opts,headers:{'Content-Type':'application/json',...await managed.headers()}});
    const data = await r.json();
    if(!r.ok) throw new Error(data.error || 'Forms request failed.');
    return data;
  }
  function snippet(form) {
    return `<form action="${endpoint(form.id)}" method="POST">
  <label>Name <input name="name" maxlength="120" autocomplete="name"></label>
  <label>Email <input type="email" name="email" maxlength="254" autocomplete="email" required></label>
${form.kind === 'contact' ? '  <label>Message <textarea name="message" maxlength="4000" required></textarea></label>\n' : ''}  <div hidden aria-hidden="true"><label>Leave empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <button type="submit">Send</button>
</form>`;
  }
  async function inbox() {
    const form = selected;
    const request = ++inboxRequest;
    byId('nativeFormSubmissions').replaceChildren();
    const result = await api(`/${form.id}/submissions`);
    if(request !== inboxRequest || selected?.id !== form.id) return;
    const box = byId('nativeFormSubmissions');
    if(!result.submissions.length) { box.textContent = 'No submissions yet.'; return; }
    for(const row of result.submissions) {
      const card = document.createElement('article');
      card.className = 'forms-submission';
      const meta = document.createElement('p');
      meta.textContent = `${new Date(row.created_at).toLocaleString()} · Email: ${row.notification_status}`;
      card.append(meta);
      for(const [key,value] of Object.entries(row.data)) {
        const p = document.createElement('p');
        p.textContent = `${key}: ${value}`;
        card.append(p);
      }
      const actions = document.createElement('div');
      actions.className = 'forms-actions';
      // Only offer a resend where it can do something: notifications on, and
      // this one is not already accepted by the provider.
      if(row.notification_status === 'failed' || row.notification_status === 'pending') {
        const resend = document.createElement('button');
        resend.type = 'button'; resend.className = 'btn ghost';
        resend.textContent = 'Send email again';
        resend.addEventListener('click',()=>run(async()=>{
          resend.disabled = true;
          try { await api(`/${form.id}/submissions/${row.id}/notify`,{method:'POST'}); status('Email sent.'); await inbox(); }
          finally { resend.disabled = false; }
        }));
        actions.append(resend);
      }
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'btn ghost danger';
      del.textContent = 'Delete';
      del.addEventListener('click',()=>run(async()=>{
        if(!confirm('Delete this submission? This cannot be undone.')) return;
        await api(`/${form.id}/submissions/${row.id}`,{method:'DELETE'});
        status('Submission deleted.');
        await inbox();
      }));
      actions.append(del);
      card.append(actions);
      box.append(card);
    }
  }
  async function choose(form) {
    selected = form;
    byId('nativeFormDetail').hidden = false;
    byId('nativeFormTitle').textContent = `${form.name} · ${form.enabled ? 'Active' : 'Paused'}`;
    byId('nativeFormPause').textContent = form.enabled ? 'Pause form' : 'Resume form';
    byId('nativeFormSnippet').value = snippet(form);
    await inbox();
  }
  async function refresh() {
    ++inboxRequest;
    selected = null;
    byId('nativeFormDetail').hidden = true;
    byId('nativeFormSubmissions').replaceChildren();
    byId('nativeFormList').replaceChildren();
    const result = await api('/');
    forms = result.forms;
    const list = byId('nativeFormList');
    for(const form of forms) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn ghost';
      button.textContent = `${form.name} (${form.kind}${form.enabled ? '' : ', paused'})`;
      button.addEventListener('click',()=>run(()=>choose(form)));
      list.append(button);
    }
    status(forms.length ? 'Choose a form to connect it or view submissions.' : 'Create your first form above.');
  }
  async function run(fn) { try { await fn(); } catch(e) { status(e.message); } }
  byId('nativeFormCreate').addEventListener('submit',event=> {
    event.preventDefault();
    const button = event.submitter || byId('nativeFormCreate').querySelector('button[type="submit"]');
    button.disabled = true;
    run(async()=>{
      const {form} = await api('/',{method:'POST',body:JSON.stringify({name:byId('nativeFormName').value,kind:byId('nativeFormKind').value,notify:byId('nativeFormNotify').checked})});
      await refresh(); await choose(form); status('Form created. Add it to your build prompt or copy the HTML.');
    }).finally(()=>{button.disabled=false;});
  });
  byId('nativeFormRefresh').addEventListener('click',()=>run(refresh));
  document.querySelector('[data-tab="forms"]').addEventListener('click',()=>run(refresh));
  byId('nativeFormInbox').addEventListener('click',()=>run(inbox));
  byId('nativeFormPause').addEventListener('click',()=>run(async()=>{
    const button = byId('nativeFormPause');
    const form = selected;
    if (!form || button.disabled) return;
    button.disabled = true;
    const enabled = !form.enabled;
    try {
      await api(`/${form.id}`,{method:'PATCH',body:JSON.stringify({enabled})});
      form.enabled = enabled;
      if (selected?.id === form.id) await choose(form);
    } finally { button.disabled = false; }
  }));
  // The export goes through fetch rather than a plain link: the route needs the
  // session header, which a link cannot carry.
  byId('nativeFormExport').addEventListener('click',()=>run(async()=>{
    if(!selected) return;
    const r = await fetch(`/api/forms/${selected.id}/submissions.csv`,{headers:await managed.headers()});
    if(!r.ok) throw new Error('Could not export these submissions.');
    const url = URL.createObjectURL(await r.blob());
    const link = document.createElement('a');
    link.href = url; link.download = `${selected.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-submissions.csv`;
    document.body.append(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
    status('CSV downloaded.');
  }));
  byId('nativeFormClear').addEventListener('click',()=>run(async()=>{
    if(!selected || !confirm(`Delete every submission for "${selected.name}"? This cannot be undone.`)) return;
    await api(`/${selected.id}/submissions`,{method:'DELETE'});
    status('All submissions deleted.');
    await inbox();
  }));
  byId('nativeFormDelete').addEventListener('click',()=>run(async()=>{
    if(!selected || !confirm(`Delete the form "${selected.name}" and all of its submissions? Any page already using it will stop working.`)) return;
    await api(`/${selected.id}`,{method:'DELETE'});
    status('Form deleted.');
    await refresh();
  }));
  byId('nativeFormCopy').addEventListener('click',()=>run(async()=>{
    await navigator.clipboard.writeText(snippet(selected)); status('HTML copied. Plain HTML submission displays a confirmation page.');
  }));
  byId('nativeFormUse').addEventListener('click',()=>{
    if(!selected?.enabled) {status('Resume this form before connecting it.');return;}
    const input = byId('promptInput');
    const instruction = `Add a ${selected.kind} form using VibeSafe Forms. POST JSON to ${endpoint(selected.id)} with email (required, max 254), name (optional, max 120)${selected.kind==='contact'?', message (required, max 4000)':''}, and a hidden honeypot field website that must stay empty. Use fetch with credentials: 'omit'. Show success only when response.ok AND the JSON body has ok:true. Show helpful errors for 400, 404, 429 and network failures. Disable Send while submitting, keep input on failure, reset on success. Do not retry automatically or submit test data. This public form ID is an identifier, not an authentication secret. Never use public guestbook records for these private enquiries. Preserve the existing design. Preview or external hosts may require allowing this exact API origin in their connect-src policy.`;
    input.value = [input.value.trim(),instruction].filter(Boolean).join('\n\n');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    activateTab('preview'); input.focus();
    status('Form instructions added. Review the estimate before building.');
  });
})();
