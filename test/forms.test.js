const {test} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {registerFormsRoutes,validateSubmission} = require('../lib/forms');
const ID = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const OWNER = {id:'owner',email:'owner@example.com',email_confirmed_at:'2026-09-17'};
function fixture({user=OWNER,notify=true,dbError=false,sendError=false,saveError=null}={}) {
  const rows = {
    native_forms:[{id:ID,owner_id:'owner',kind:'contact',name:'Contact',enabled:true,notify,notification_email:'owner@example.com'}],
    native_form_submissions:[],
  };
  const emails=[];
  const db={
    from(table){
      let filters=[],patch=null;
      let removing=false;
      const result2=()=>{
        if(dbError) return {data:null,error:{message:'internal database credentials should not leak'}};
        const found=rows[table].filter(r=>filters.every(([k,v])=>r[k]===v));
        if(removing) rows[table]=rows[table].filter(r=>!found.includes(r));
        else if(patch) found.forEach(r=>Object.assign(r,patch));
        return {data:found,error:null};
      };
      const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},order(){return q;},limit(){return q;},update(p){patch=p;return q;},delete(){removing=true;return q;},maybeSingle(){const r=result2();return Promise.resolve({...r,data:r.data?.[0]||null});},then(ok,bad){return Promise.resolve(result2()).then(ok,bad);}};
      return q;
    },
    async rpc(fn,p){
      if(saveError) return {data:null,error:{message:saveError}};
      if(fn==='create_native_form') {
        const row={id:ID,owner_id:p.p_owner,name:p.p_name,kind:p.p_kind,notification_email:p.p_email,notify:p.p_notify,enabled:true};
        rows.native_forms.push(row); return {data:row,error:null};
      }
      const f=rows.native_forms.find(r=>r.id===p.p_form);
      const row={id:SUB,form_id:ID,owner_id:f.owner_id,data:p.p_data,notification_status:notify?'pending':'disabled'};
      rows.native_form_submissions.push(row);
      return {data:{id:row.id,notify,email:f.notification_email,name:f.name},error:null};
    },
  };
  const app=express(); app.use(express.json());
  registerFormsRoutes(app,{supabaseAdmin:db,getManagedUser:async()=>user,sendEmail:async args=>{
    assert.equal(rows.native_form_submissions.length,1,'persist before email');
    emails.push(args);if(sendError)throw Error('provider failed');return {ok:true};
  }});
  return {app,rows,emails};
}
async function request(f,path,{method='GET',body,encoded=false}={}) {
  const server=f.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
    const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':encoded?'application/x-www-form-urlencoded':'application/json'},body:body===undefined?undefined:encoded?new URLSearchParams(body):JSON.stringify(body)});
    const text=await r.text();return {status:r.status,text,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):null,headers:r.headers};
  } finally {await new Promise(resolve=>server.close(resolve));}
}
const submission={email:'visitor@example.com',name:'Visitor',message:'Please call me'};
const path=`/api/forms/public/${ID}/submit`;
test('validation whitelists fields and rejects invalid content',()=>{
  assert.deepEqual(validateSubmission({...submission,owner_id:'attacker',to:'attacker@example.com'},'contact'),submission);
  for(const body of [null,[],{...submission,email:'bad'},{...submission,message:''},{...submission,message:'x'.repeat(4001)},{...submission,name:{} }]) assert.throws(()=>validateSubmission(body,'contact'));
  assert.deepEqual(validateSubmission({email:'a@b.com'},'waitlist'),{email:'a@b.com',name:''});
});
test('all management endpoints require authentication',async()=>{
  for(const [url,method,body] of [['/api/forms/','GET'],['/api/forms/','POST',{}],[`/api/forms/${ID}`,'PATCH',{enabled:false}],[`/api/forms/${ID}/submissions`,'GET']]) {
    const r=await request(fixture({user:null}),url,{method,body});assert.equal(r.status,401);
  }
});
test('other owners cannot list, read or pause a form',async()=>{
  const f=fixture({user:{...OWNER,id:'other'}});
  assert.deepEqual((await request(f,'/api/forms/')).data.forms,[]);
  assert.equal((await request(f,`/api/forms/${ID}/submissions`)).status,404);
  assert.equal((await request(f,`/api/forms/${ID}`,{method:'PATCH',body:{enabled:false}})).status,404);
  assert.equal(f.rows.native_forms[0].enabled,true);
});
test('public submissions are stored privately and emailed only to owner',async()=>{
  const f=fixture();
  const r=await request(f,path,{method:'POST',body:{...submission,to:'attacker@example.com',owner_id:'attacker'}});
  assert.equal(r.status,201);assert.deepEqual(r.data,{ok:true});assert.ok(!r.text.includes('owner@example.com'));
  assert.equal(f.emails[0].to,'owner@example.com');assert.equal(f.rows.native_form_submissions[0].owner_id,'owner');
  assert.equal(f.rows.native_form_submissions[0].notification_status,'sent');
  assert.equal((await request(f,`/api/forms/${ID}/submissions`)).data.submissions.length,1);
});
test('failed email does not lose a submission or report public failure',async()=>{
  const f=fixture({sendError:true});const r=await request(f,path,{method:'POST',body:submission});
  assert.equal(r.status,201);assert.equal(f.rows.native_form_submissions[0].notification_status,'failed');
});
test('spam honeypot does not store or email',async()=>{
  const f=fixture();assert.equal((await request(f,path,{method:'POST',body:{...submission,website:'spam'}})).status,200);
  assert.equal(f.rows.native_form_submissions.length,0);assert.equal(f.emails.length,0);
});
test('paused form rejects public writes',async()=>{
  const f=fixture();await request(f,`/api/forms/${ID}`,{method:'PATCH',body:{enabled:false}});
  assert.equal((await request(f,path,{method:'POST',body:submission})).status,404);
  assert.equal(f.emails.length,0);
});
test('database rate limits and quotas stop email and return 429',async()=>{
  for(const saveError of ['rate_limit','submission_limit']) {
    const f=fixture({saveError});assert.equal((await request(f,path,{method:'POST',body:submission})).status,429);assert.equal(f.emails.length,0);
  }
});
test('database failures are closed and do not disclose internal details',async()=>{
  const f=fixture({dbError:true});const r=await request(f,path,{method:'POST',body:submission});
  assert.equal(r.status,503);assert.ok(!r.text.includes('credentials'));assert.equal(f.emails.length,0);
});
test('creation takes owner and recipient from verified session, not request',async()=>{
  const f=fixture();const body={name:'Waitlist',kind:'waitlist',notify:true,p_owner:'other',email:'other@example.com'};
  const r=await request(f,'/api/forms/',{method:'POST',body});assert.equal(r.status,201);
  assert.equal(f.rows.native_forms[1].notification_email,OWNER.email);assert.equal(f.rows.native_forms[1].owner_id,OWNER.id);
  assert.equal((await request(fixture({user:{...OWNER,email_confirmed_at:null}}),'/api/forms/',{method:'POST',body})).status,403);
});
test('email contents are escaped; notification opt out is respected',async()=>{
  const f=fixture();await request(f,path,{method:'POST',body:{...submission,message:'<script>alert(1)</script>'}});
  assert.ok(f.emails[0].html.includes('&lt;script&gt;'));assert.ok(!f.emails[0].html.includes('<script>'));
  const quiet=fixture({notify:false});await request(quiet,path,{method:'POST',body:submission});assert.equal(quiet.emails.length,0);
});
test('HTML form submission returns a readable confirmation and CORS is scoped',async()=>{
  const f=fixture();const r=await request(f,path,{method:'POST',body:submission,encoded:true});assert.equal(r.status,201);assert.ok(r.text.includes('Thank you'));
  assert.equal(r.headers.get('access-control-allow-origin'),'*');
  assert.equal((await request(f,'/api/forms/')).headers.get('access-control-allow-origin'),null);
});

/* ---- owning the data: delete, export, resend ---- */

const stored = async f => { await request(f,path,{method:'POST',body:submission}); return f; };

test('an owner can delete one submission, and only their own',async()=>{
  const f=await stored(fixture());
  assert.equal((await request(f,`/api/forms/${ID}/submissions/${SUB}`,{method:'DELETE'})).status,200);
  assert.equal(f.rows.native_form_submissions.length,0);
  assert.equal((await request(fixture({user:{...OWNER,id:'other'}}),`/api/forms/${ID}/submissions/${SUB}`,{method:'DELETE'})).status,404);
});

test('clearing an inbox removes every submission for that form',async()=>{
  const f=await stored(fixture());
  await request(f,path,{method:'POST',body:submission});
  assert.equal((await request(f,`/api/forms/${ID}/submissions`,{method:'DELETE'})).status,200);
  assert.equal(f.rows.native_form_submissions.length,0);
});

test('deleting a form is owner-scoped',async()=>{
  const f=await stored(fixture());
  assert.equal((await request(fixture({user:{...OWNER,id:'other'}}),`/api/forms/${ID}`,{method:'DELETE'})).status,404);
  assert.equal((await request(f,`/api/forms/${ID}`,{method:'DELETE'})).status,200);
  assert.equal(f.rows.native_forms.length,0);
});

test('CSV export is owner-scoped and neutralises spreadsheet formulas',async()=>{
  const f=fixture();
  await request(f,path,{method:'POST',body:{...submission,message:'=cmd|calc'}});
  const r=await request(f,`/api/forms/${ID}/submissions.csv`);
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-type'),/text\/csv/);
  assert.match(r.headers.get('content-disposition'),/attachment/);
  assert.ok(r.text.startsWith('received,email_status,name,email,message'));
  assert.ok(r.text.includes(String.fromCharCode(34,39) + "=cmd|calc" + String.fromCharCode(34)), "formula prefixed with an apostrophe");
  assert.equal((await request(fixture({user:{...OWNER,id:'other'}}),`/api/forms/${ID}/submissions.csv`)).status,404);
});

test('a failed notification can be resent, and never to a submitted address',async()=>{
  const f=await stored(fixture({sendError:true}));
  assert.equal(f.rows.native_form_submissions[0].notification_status,'failed');
  f.emails.length=0;
  const r=await request(f,`/api/forms/${ID}/submissions/${SUB}/notify`,{method:'POST'});
  assert.equal(r.status,502,'a provider that keeps failing is reported, not hidden');
  assert.equal(f.emails[0].to,'owner@example.com');
  const quiet=await stored(fixture({notify:false}));
  assert.equal((await request(quiet,`/api/forms/${ID}/submissions/${SUB}/notify`,{method:'POST'})).status,400);
  assert.equal((await request(fixture({user:{...OWNER,id:'other'}}),`/api/forms/${ID}/submissions/${SUB}/notify`,{method:'POST'})).status,404);
});

test('the new routes reject unauthenticated callers',async()=>{
  for(const [url,method] of [[`/api/forms/${ID}`,'DELETE'],[`/api/forms/${ID}/submissions`,'DELETE'],[`/api/forms/${ID}/submissions/${SUB}`,'DELETE'],[`/api/forms/${ID}/submissions.csv`,'GET'],[`/api/forms/${ID}/submissions/${SUB}/notify`,'POST']]) {
    assert.equal((await request(fixture({user:null}),url,{method})).status,401,url);
  }
});
