"use strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function validateSubmission(body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid submission.');
  const field = (key, max, required) => {
    const value = body[key] === undefined ? '' : body[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`Check the ${key} field.`);
    return value.trim();
  };
  const email = field('email', 254, true);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || /[\r\n]/.test(email)) throw new Error('Enter a valid email address.');
  const result = { email, name: field('name', 120, false) };
  if (kind === 'contact') result.message = field('message', 4000, true);
  return result; // Never accept caller-supplied owner, recipient, or notification fields.
}

function registerFormsRoutes(app, { supabaseAdmin: db, getManagedUser, sendEmail }) {
  const express = require('express');
  const publicRouter = express.Router();
  const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(() => res.status(503).json({error:'Forms are temporarily unavailable. Please try again.'}));
  publicRouter.use((req,res,next) => {
    res.set('Access-Control-Allow-Origin','*');
    res.set('Access-Control-Allow-Headers','Content-Type');
    res.set('Access-Control-Allow-Methods','POST, OPTIONS');
    if(req.method==='OPTIONS') return res.status(204).end();
    next();
  });
  publicRouter.use(express.urlencoded({extended:false,limit:'16kb'}));
  publicRouter.post('/:id/submit', wrap(async(req,res) => {
    if (!db) return res.status(503).json({error:'Forms are not configured yet.'});
    if (!UUID.test(req.params.id)) return res.status(404).json({error:'Form unavailable.'});
    if (req.body?.website) return res.json({ok:true}); // Honeypot: never store or email.
    const {data:form,error} = await db.from('native_forms').select('kind,enabled').eq('id',req.params.id).maybeSingle();
    if(error) throw error;
    if(!form?.enabled) return res.status(404).json({error:'Form unavailable.'});
    let fields;
    try { fields = validateSubmission(req.body,form.kind); }
    catch(e) { return res.status(400).json({error:e.message}); }
    const {data:saved,error:saveError} = await db.rpc('submit_native_form',{p_form:req.params.id,p_data:fields});
    if(saveError) {
      if(/rate_limit|submission_limit/.test(saveError.message)) return res.status(429).json({error:'This form is temporarily unable to accept more submissions. Please try again later.'});
      if(/form_unavailable/.test(saveError.message)) return res.status(404).json({error:'Form unavailable.'});
      throw saveError;
    }
    // Storage committed before email. No LLM, caller-selected recipient, or auto reply.
    if(saved.notify) {
      let delivered = false;
      try {
        const result = await sendEmail({to:saved.email,subject:'New VibeSafe Forms submission',idempotencyKey:`native-form-${saved.id}`,timeoutMs:10000,html:
          `<h2>${escapeHtml(saved.name)}</h2>` + Object.entries(fields).map(([k,v])=>`<p><b>${escapeHtml(k)}</b>: ${escapeHtml(v)}</p>`).join('')});
        delivered = result.ok === true;
      } catch { /* Saved enquiry remains available even if delivery fails. */ }
      // If this update fails, owner sees pending rather than a false success.
      try { await db.from('native_form_submissions').update({notification_status:delivered?'sent':'failed'}).eq('id',saved.id); }
      catch { /* The saved enquiry succeeded; do not encourage a duplicate retry. */ }
    }
    if(req.is('application/x-www-form-urlencoded')) return res.status(201).type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Submission received</title><body><h1>Thank you</h1><p>Your submission has been saved. You can return to the previous page.</p></body></html>');
    return res.status(201).json({ok:true});
  }));
  app.use('/api/forms/public',publicRouter);

  const owner = express.Router();
  owner.use(wrap(async(req,res,next) => {
    res.set('Cache-Control','no-store');
    if(!db) return res.status(503).json({error:'Forms need the native-forms database migration before use.'});
    const user = await getManagedUser(req);
    if(!user) return res.status(401).json({error:'Sign in to manage your forms.'});
    req.formOwner = user;
    next();
  }));
  owner.get('/',wrap(async(req,res) => {
    const {data,error} = await db.from('native_forms').select('id,name,kind,notify,enabled,created_at').eq('owner_id',req.formOwner.id).order('created_at',{ascending:false});
    if(error) throw error;
    res.json({forms:data});
  }));
  owner.post('/',wrap(async(req,res) => {
    const b = req.body || {};
    if(typeof b.name!=='string' || !b.name.trim() || b.name.length>80 || !['contact','waitlist'].includes(b.kind) || typeof b.notify!=='boolean') return res.status(400).json({error:'Provide a form name, type, and notification preference.'});
    if(!req.formOwner.email || !req.formOwner.email_confirmed_at) return res.status(403).json({error:'Verify your account email before creating a form.'});
    const {data,error} = await db.rpc('create_native_form',{p_owner:req.formOwner.id,p_name:b.name.trim(),p_kind:b.kind,p_email:req.formOwner.email,p_notify:b.notify});
    if(error) {
      if(error.message.includes('form_limit')) return res.status(409).json({error:'You can create up to 20 forms.'});
      throw error;
    }
    res.status(201).json({form:{id:data.id,name:data.name,kind:data.kind,notify:data.notify,enabled:data.enabled}});
  }));
  owner.patch('/:id',wrap(async(req,res) => {
    if(!UUID.test(req.params.id) || typeof req.body?.enabled!=='boolean') return res.status(400).json({error:'Invalid form update.'});
    const {data,error} = await db.from('native_forms').update({enabled:req.body.enabled}).eq('id',req.params.id).eq('owner_id',req.formOwner.id).select('id').maybeSingle();
    if(error) throw error;
    if(!data) return res.status(404).json({error:'Form not found.'});
    res.json({ok:true});
  }));
  owner.get('/:id/submissions',wrap(async(req,res) => {
    if(!UUID.test(req.params.id)) return res.status(404).json({error:'Form not found.'});
    const {data:form,error:ferror} = await db.from('native_forms').select('id').eq('id',req.params.id).eq('owner_id',req.formOwner.id).maybeSingle();
    if(ferror) throw ferror;
    if(!form) return res.status(404).json({error:'Form not found.'});
    const {data,error} = await db.from('native_form_submissions').select('id,data,created_at,notification_status').eq('form_id',form.id).eq('owner_id',req.formOwner.id).order('created_at',{ascending:false}).limit(1000);
    if(error) throw error;
    res.json({submissions:data});
  }));
  app.use('/api/forms',owner);
}
module.exports = { registerFormsRoutes, validateSubmission };
