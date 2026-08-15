"use strict";
/* Pre-built starting apps — instant v1, zero generation cost.
   Each is a complete, working single-file app meeting the same quality bar
   the AI generator is held to: no placeholders, no hardcoded secrets, no eval,
   localStorage for persistence, mobile-friendly. */

window.TEMPLATES = [
  {
    id: "habit-tracker",
    icon: "🔥",
    name: "Habit Tracker",
    desc: "Daily habits with streaks",
    prompt: "Build a habit tracker where I can add daily habits and check them off. Show a 7-day streak for each habit and save everything in the browser.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Habit Tracker</title>
<style>
:root{--bg:#12100f;--panel:#1c1917;--line:#312d29;--text:#f2ede6;--dim:#a89f92;--accent:#e8935a}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,serif;background:var(--bg);color:var(--text);min-height:100vh;padding:24px}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:26px;margin-bottom:4px}
.sub{color:var(--dim);font-size:14px;margin-bottom:24px}
.add{display:flex;gap:8px;margin-bottom:20px}
input{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;color:var(--text);font-size:15px}
button{background:var(--accent);color:#2a1608;border:none;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;font-size:14px}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);padding:5px 10px;font-weight:400}
.habit{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.habit-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.habit-name{font-size:16px}
.streak{color:var(--accent);font-size:13px;font-weight:700}
.days{display:flex;gap:5px}
.day{flex:1;aspect-ratio:1;border-radius:6px;background:#2a251f;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dim);border:1px solid var(--line)}
.day.done{background:var(--accent);color:#2a1608;font-weight:700;border-color:var(--accent)}
.day.today{outline:2px solid var(--accent);outline-offset:1px}
.empty{color:var(--dim);text-align:center;padding:40px 0;font-style:italic}
</style></head>
<body><div class="wrap">
<h1>🔥 Habit Tracker</h1>
<p class="sub">Build streaks, one day at a time.</p>
<div class="add"><input id="habitInput" placeholder="New habit, e.g. Drink water" /><button id="addBtn">Add</button></div>
<div id="list"></div>
</div>
<script>
const DAY_MS=86400000;
let habits=JSON.parse(localStorage.getItem("habits")||"[]");
function todayKey(offset=0){const d=new Date();d.setDate(d.getDate()-offset);return d.toISOString().slice(0,10)}
function save(){localStorage.setItem("habits",JSON.stringify(habits))}
function streak(h){let s=0;for(let i=0;;i++){if(h.done[todayKey(i)])s++;else break}return s}
function render(){
  const list=document.getElementById("list");
  if(!habits.length){list.innerHTML='<div class="empty">No habits yet — add one above.</div>';return}
  list.innerHTML=habits.map((h,hi)=>{
    const days=[...Array(7)].map((_,i)=>6-i).map(off=>{
      const key=todayKey(off);const done=!!h.done[key];const isToday=off===0;
      const label=new Date(Date.now()-off*DAY_MS).toLocaleDateString(undefined,{weekday:"narrow"});
      return \`<div class="day \${done?"done":""} \${isToday?"today":""}" data-h="\${hi}" data-k="\${key}">\${label}</div>\`;
    }).join("");
    return \`<div class="habit"><div class="habit-top"><span class="habit-name">\${h.name}</span>
      <span class="streak">\${streak(h)} day streak</span></div><div class="days">\${days}</div>
      <button class="ghost" data-del="\${hi}" style="margin-top:8px">Remove</button></div>\`;
  }).join("");
}
document.getElementById("addBtn").onclick=()=>{
  const v=document.getElementById("habitInput").value.trim();
  if(!v)return;habits.push({name:v,done:{}});document.getElementById("habitInput").value="";save();render();
};
document.getElementById("habitInput").addEventListener("keydown",e=>{if(e.key==="Enter")document.getElementById("addBtn").click()});
document.getElementById("list").addEventListener("click",e=>{
  const day=e.target.closest("[data-h]");
  if(day){const h=habits[+day.dataset.h];h.done[day.dataset.k]=!h.done[day.dataset.k];save();render();return}
  const del=e.target.closest("[data-del]");
  if(del){habits.splice(+del.dataset.del,1);save();render()}
});
render();
</script></body></html>`,
  },
  {
    id: "invoice-generator",
    icon: "🧾",
    name: "Invoice Generator",
    desc: "Line items, totals, printable",
    prompt: "Build an invoice generator — let me add line items with quantity and price, auto-calculate the total, and print or save it as a PDF.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Generator</title>
<style>
:root{--bg:#f7f5f0;--ink:#1e2a26;--line:#d8d2c4;--accent:#2f6f5e}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink);padding:24px}
.wrap{max-width:720px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:12px;padding:32px}
.row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.field{flex:1;min-width:180px}
label{display:block;font-size:12px;color:#6b6355;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px}
input,textarea{width:100%;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:14px;font-family:inherit}
h1{font-size:22px;color:var(--accent);margin-bottom:2px}
.brand{font-size:13px;color:#6b6355;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{text-align:left;font-size:12px;color:#6b6355;text-transform:uppercase;letter-spacing:.4px;padding:6px 4px;border-bottom:2px solid var(--line)}
td{padding:6px 4px;border-bottom:1px solid var(--line)}
td input{border:none;padding:4px}
.qty,.price,.amt{width:80px;text-align:right}
.amt-val{text-align:right;font-variant-numeric:tabular-nums}
.totals{margin-left:auto;width:220px;margin-top:10px}
.totals div{display:flex;justify-content:space-between;padding:4px 0;font-size:14px}
.totals .grand{font-weight:700;font-size:17px;border-top:2px solid var(--ink);margin-top:6px;padding-top:8px}
.actions{display:flex;gap:10px;margin-top:24px}
button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
@media print{.actions,.field input,label{display:none !important}.wrap{border:none}}
</style></head>
<body><div class="wrap">
<h1>Invoice</h1>
<div class="brand">Fill in your details below — this generates a clean, printable invoice.</div>
<div class="row">
  <div class="field"><label>From</label><input id="from" placeholder="Your business name"></div>
  <div class="field"><label>To</label><input id="to" placeholder="Client name"></div>
</div>
<div class="row">
  <div class="field"><label>Invoice #</label><input id="num" value="INV-001"></div>
  <div class="field"><label>Date</label><input id="date" type="date"></div>
</div>
<table><thead><tr><th>Description</th><th class="qty">Qty</th><th class="price">Price</th><th class="amt">Amount</th><th></th></tr></thead>
<tbody id="items"></tbody></table>
<button class="ghost" id="addItem" type="button">+ Add line item</button>
<div class="totals"><div><span>Subtotal</span><span id="subtotal">$0.00</span></div>
<div class="grand"><span>Total</span><span id="total">$0.00</span></div></div>
<div class="actions"><button id="printBtn">Print / Save as PDF</button><button class="ghost" id="clearBtn" type="button">Clear</button></div>
</div>
<script>
const itemsEl=document.getElementById("items");
document.getElementById("date").value=new Date().toISOString().slice(0,10);
function addRow(desc="",qty=1,price=0){
  const tr=document.createElement("tr");
  tr.innerHTML=\`<td><input class="desc" value="\${desc}" placeholder="Item or service"></td>
    <td><input class="qty" type="number" value="\${qty}" min="0"></td>
    <td><input class="price" type="number" value="\${price}" min="0" step="0.01"></td>
    <td class="amt-val">$0.00</td><td><button class="ghost" type="button" data-rm>✕</button></td>\`;
  itemsEl.appendChild(tr);calc();
}
function calc(){
  let sub=0;
  itemsEl.querySelectorAll("tr").forEach(tr=>{
    const q=+tr.querySelector(".qty").value||0,p=+tr.querySelector(".price").value||0,amt=q*p;
    tr.querySelector(".amt-val").textContent="$"+amt.toFixed(2);sub+=amt;
  });
  document.getElementById("subtotal").textContent="$"+sub.toFixed(2);
  document.getElementById("total").textContent="$"+sub.toFixed(2);
}
itemsEl.addEventListener("input",calc);
itemsEl.addEventListener("click",e=>{if(e.target.closest("[data-rm]")){e.target.closest("tr").remove();calc()}});
document.getElementById("addItem").onclick=()=>addRow();
document.getElementById("printBtn").onclick=()=>window.print();
document.getElementById("clearBtn").onclick=()=>{itemsEl.innerHTML="";addRow()};
addRow("Consulting hours",1,0);
</script></body></html>`,
  },
  {
    id: "flashcards",
    icon: "🗂️",
    name: "Flashcards",
    desc: "Study any subject, self-graded",
    prompt: "Build a flashcard app for studying — I add cards with a question and answer, flip through them one at a time, and mark each one right or wrong to self-grade.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flashcards</title>
<style>
:root{--bg:#161a23;--panel:#1f2530;--line:#2e3646;--text:#eef1f6;--dim:#8a93a6;--accent:#6c8cff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px}
h1{margin-bottom:16px;font-size:22px}
.setup{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;width:100%;max-width:420px}
.setup textarea{width:100%;height:140px;background:#141822;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px;font-family:inherit;font-size:13px;margin-top:8px}
.hint{color:var(--dim);font-size:12px;margin-top:6px}
button{background:var(--accent);color:#0d1424;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer;margin-top:12px}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
.card-area{max-width:420px;width:100%;text-align:center}
.progress{color:var(--dim);font-size:13px;margin-bottom:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;min-height:200px;display:flex;align-items:center;justify-content:center;padding:24px;font-size:19px;cursor:pointer;user-select:none}
.card .face{color:var(--dim);font-size:11px;position:absolute;margin-top:-90px;text-transform:uppercase;letter-spacing:.5px}
.grade{display:flex;gap:10px;justify-content:center;margin-top:16px}
.grade button{flex:1;max-width:120px}
.grade .again{background:#e0645933;color:#f0a9a2;border:1px solid #e06459}
.grade .good{background:#35c28f33;color:#9fe8cd;border:1px solid #35c28f}
.done{padding:40px;color:var(--dim)}
</style></head>
<body>
<h1>🗂️ Flashcards</h1>
<div class="setup" id="setup">
  <label>One card per line, front and back separated by " :: "</label>
  <textarea id="src" placeholder="Capital of France :: Paris&#10;2 + 2 :: 4"></textarea>
  <div class="hint">Example loaded below — replace with your own subject any time.</div>
  <button id="startBtn">Start studying</button>
</div>
<div class="card-area" id="study" style="display:none">
  <div class="progress" id="progress"></div>
  <div class="card" id="card"></div>
  <div class="grade" id="grade" style="visibility:hidden">
    <button class="again" data-g="again">Still learning</button>
    <button class="good" data-g="good">Got it</button>
  </div>
  <button class="ghost" id="restartBtn" style="margin-top:20px">↺ New deck</button>
</div>
<script>
let deck=[],idx=0,showingBack=false,learned=0;
const sample="What is the capital of France? :: Paris\\nWhat is 12 x 12? :: 144\\nWhat gas do plants absorb? :: Carbon dioxide";
document.getElementById("src").value=sample;
document.getElementById("startBtn").onclick=()=>{
  deck=document.getElementById("src").value.split("\\n").map(l=>l.split("::")).filter(p=>p.length===2)
    .map(([f,b])=>({front:f.trim(),back:b.trim()}));
  if(!deck.length)return alert("Add at least one card using the :: format.");
  idx=0;learned=0;showingBack=false;
  document.getElementById("setup").style.display="none";
  document.getElementById("study").style.display="block";
  render();
};
function render(){
  if(idx>=deck.length){
    document.getElementById("card").innerHTML='<div class="done">🎉 Done! '+learned+' / '+deck.length+' marked as learned.</div>';
    document.getElementById("progress").textContent="";
    document.getElementById("grade").style.visibility="hidden";
    return;
  }
  showingBack=false;
  document.getElementById("progress").textContent="Card "+(idx+1)+" of "+deck.length;
  document.getElementById("card").textContent=deck[idx].front;
  document.getElementById("grade").style.visibility="hidden";
}
document.getElementById("card").onclick=()=>{
  if(idx>=deck.length)return;
  showingBack=!showingBack;
  document.getElementById("card").textContent=showingBack?deck[idx].back:deck[idx].front;
  document.getElementById("grade").style.visibility=showingBack?"visible":"hidden";
};
document.getElementById("grade").addEventListener("click",e=>{
  const b=e.target.closest("[data-g]");if(!b)return;
  if(b.dataset.g==="good")learned++;
  idx++;render();
});
document.getElementById("restartBtn").onclick=()=>{
  document.getElementById("setup").style.display="block";
  document.getElementById("study").style.display="none";
};
</script></body></html>`,
  },
  {
    id: "quiz-maker",
    icon: "❓",
    name: "Quiz Maker",
    desc: "Multiple-choice quiz with scoring",
    prompt: "Build a multiple-choice quiz app — let me add questions with 4 answer options and mark the correct one, then take the quiz and see my score at the end.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quiz Maker</title>
<style>
:root{--bg:#1a1610;--panel:#241d15;--line:#3a2f21;--text:#f3ead9;--dim:#a99a80;--accent:#e0a84b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;justify-content:center;padding:24px}
.wrap{max-width:480px;width:100%}
h1{font-size:22px;margin-bottom:16px}
.q-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px}
.q-num{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.q-text{font-size:17px;margin-bottom:16px}
.opt{display:block;width:100%;text-align:left;background:#1e1810;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;font-size:14px}
.opt:hover{border-color:var(--accent)}
.opt.correct{border-color:#35c28f;background:#35c28f22}
.opt.wrong{border-color:#e06459;background:#e0645922}
.opt[disabled]{cursor:default}
button.next{margin-top:14px;background:var(--accent);color:#2a1a08;border:none;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer}
.score{text-align:center;padding:40px 0}
.score .big{font-size:40px;font-weight:800;color:var(--accent)}
.score button{margin-top:16px}
</style></head>
<body><div class="wrap">
<h1>❓ Quick Quiz</h1>
<div id="app"></div>
</div>
<script>
const QUESTIONS=[
  {q:"What language runs in a web browser?",opts:["Python","JavaScript","C++","Swift"],a:1},
  {q:"What does CSS stand for?",opts:["Central Style Sheets","Cascading Style Sheets","Colorful Style Sheets","Creative Style System"],a:1},
  {q:"Which of these is NOT a primary color of light?",opts:["Red","Green","Blue","Yellow"],a:3},
  {q:"What year is it roughly, if this app says 2026?",opts:["2020","2023","2026","2030"],a:2},
];
let idx=0,score=0,answered=false;
function render(){
  const app=document.getElementById("app");
  if(idx>=QUESTIONS.length){
    app.innerHTML=\`<div class="q-card score"><div>Your score</div><div class="big">\${score} / \${QUESTIONS.length}</div>
      <button class="next" id="restart">Try again</button></div>\`;
    document.getElementById("restart").onclick=()=>{idx=0;score=0;render()};
    return;
  }
  const cur=QUESTIONS[idx];answered=false;
  app.innerHTML=\`<div class="q-card"><div class="q-num">Question \${idx+1} of \${QUESTIONS.length}</div>
    <div class="q-text">\${cur.q}</div>
    \${cur.opts.map((o,i)=>\`<button class="opt" data-i="\${i}">\${o}</button>\`).join("")}
    </div>\`;
}
document.getElementById("app").addEventListener("click",e=>{
  const btn=e.target.closest(".opt");
  if(!btn||answered)return;
  answered=true;
  const cur=QUESTIONS[idx],chosen=+btn.dataset.i;
  document.querySelectorAll(".opt").forEach((el,i)=>{
    el.disabled=true;
    if(i===cur.a)el.classList.add("correct");
    else if(i===chosen)el.classList.add("wrong");
  });
  if(chosen===cur.a)score++;
  const next=document.createElement("button");
  next.className="next";next.textContent=idx===QUESTIONS.length-1?"See score":"Next question";
  next.onclick=()=>{idx++;render()};
  document.querySelector(".q-card").appendChild(next);
});
render();
</script></body></html>`,
  },
  {
    id: "landing-page",
    icon: "🚀",
    name: "Landing Page",
    desc: "One-page site for a product or service",
    prompt: "Build a one-page landing site for my product — a hero section with a headline, a few feature highlights, and a call-to-action button.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Product</title>
<style>
:root{--bg:#0e1210;--panel:#161c19;--line:#263029;--text:#eef4f0;--dim:#8fa198;--accent:#5ad1a3}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.wrap{max-width:880px;margin:0 auto;padding:0 24px}
nav{display:flex;align-items:center;padding:20px 0}
.logo{font-weight:800}
.logo span{color:var(--accent)}
nav a.cta{margin-left:auto;background:var(--accent);color:#04241a;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px}
.hero{padding:64px 0 48px;text-align:center}
.hero h1{font-size:clamp(28px,5vw,44px);font-weight:800;letter-spacing:-.5px}
.hero p{color:var(--dim);font-size:17px;max-width:560px;margin:16px auto 0}
.hero .btns{margin-top:28px;display:flex;gap:12px;justify-content:center}
.btn{padding:11px 22px;border-radius:9px;text-decoration:none;font-size:14px;border:1px solid var(--line);color:var(--text)}
.btn.primary{background:var(--accent);color:#04241a;font-weight:700;border-color:var(--accent)}
.features{padding:48px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.feature{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
.feature .ic{font-size:22px;margin-bottom:8px}
.feature h3{font-size:15px;margin-bottom:6px}
.feature p{color:var(--dim);font-size:13px}
footer{border-top:1px solid var(--line);padding:24px 0;color:var(--dim);font-size:13px;text-align:center}
</style></head>
<body><div class="wrap">
<nav><div class="logo">◆ Your<span>Product</span></div><a class="cta" href="#get-started">Get started</a></nav>
<div class="hero">
  <h1>Edit this headline to say what you do.</h1>
  <p>Replace this paragraph with one sentence that explains who this is for and why it matters to them.</p>
  <div class="btns"><a class="btn primary" href="#get-started">Get started free</a><a class="btn" href="#features">Learn more</a></div>
</div>
<div class="features" id="features">
  <div class="feature"><div class="ic">⚡</div><h3>Fast</h3><p>Describe the first benefit of your product here.</p></div>
  <div class="feature"><div class="ic">🔒</div><h3>Secure</h3><p>Describe the second benefit of your product here.</p></div>
  <div class="feature"><div class="ic">💬</div><h3>Simple</h3><p>Describe the third benefit of your product here.</p></div>
</div>
</div>
<footer id="get-started">Edit this footer with your contact info or a signup form. Built with VibeSafe Builder.</footer>
</body></html>`,
  },
  {
    id: "booking-form",
    icon: "📅",
    name: "Booking Form",
    desc: "Appointment requests, saved locally",
    prompt: "Build a booking form where people can request an appointment with their name, preferred date, and time, and I can see the list of requests.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book an Appointment</title>
<style>
:root{--bg:#101420;--panel:#181e2c;--line:#2a3348;--text:#e9edf7;--dim:#8791a8;--accent:#7c9eff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:24px;display:flex;gap:24px;flex-wrap:wrap;justify-content:center}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;width:100%;max-width:380px}
h1{font-size:19px;margin-bottom:16px}
label{display:block;font-size:12px;color:var(--dim);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.4px}
input,select,textarea{width:100%;background:#0e1320;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 11px;font-size:14px;font-family:inherit}
textarea{min-height:70px}
button{margin-top:18px;width:100%;background:var(--accent);color:#0c1428;border:none;border-radius:9px;padding:11px;font-weight:700;cursor:pointer}
.list h2{font-size:15px;margin-bottom:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
.booking{background:#0e1320;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:8px;font-size:13px}
.booking .when{color:var(--accent);font-weight:700}
.empty{color:var(--dim);font-size:13px;font-style:italic}
.msg{background:#35c28f22;border:1px solid #35c28f;color:#9fe8cd;border-radius:8px;padding:10px;margin-top:14px;font-size:13px;display:none}
</style></head>
<body>
<div class="card">
  <h1>📅 Book an appointment</h1>
  <form id="form">
    <label>Name</label><input id="name" required>
    <label>Email</label><input id="email" type="email" required>
    <label>Date</label><input id="date" type="date" required>
    <label>Time</label><input id="time" type="time" required>
    <label>Notes (optional)</label><textarea id="notes"></textarea>
    <button type="submit">Request booking</button>
    <div class="msg" id="msg">✓ Booking saved below. (This demo stores requests locally — connect email or a calendar API when you're ready.)</div>
  </form>
</div>
<div class="card list">
  <h2>Requested bookings</h2>
  <div id="bookings"></div>
</div>
<script>
let bookings=JSON.parse(localStorage.getItem("bookings")||"[]");
function render(){
  const el=document.getElementById("bookings");
  if(!bookings.length){el.innerHTML='<div class="empty">No bookings yet.</div>';return}
  el.innerHTML=[...bookings].reverse().map(b=>
    \`<div class="booking"><div class="when">\${b.date} at \${b.time}</div>\${b.name} — \${b.email}\${b.notes?"<br><em>"+b.notes+"</em>":""}</div>\`
  ).join("");
}
document.getElementById("form").addEventListener("submit",e=>{
  e.preventDefault();
  bookings.push({
    name:document.getElementById("name").value,
    email:document.getElementById("email").value,
    date:document.getElementById("date").value,
    time:document.getElementById("time").value,
    notes:document.getElementById("notes").value,
  });
  localStorage.setItem("bookings",JSON.stringify(bookings));
  document.getElementById("form").reset();
  document.getElementById("msg").style.display="block";
  setTimeout(()=>document.getElementById("msg").style.display="none",4000);
  render();
});
render();
</script></body></html>`,
  },
  {
    id: "focus-timer",
    icon: "⏱️",
    name: "Focus Timer",
    desc: "Pomodoro-style work/break sessions",
    prompt: "Build a Pomodoro-style focus timer — 25 minutes of work followed by a 5 minute break, with start/pause/reset buttons and a sound when time's up.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Focus Timer</title>
<style>
:root{--bg:#151022;--panel:#1f1934;--line:#332a54;--text:#f0edfa;--dim:#a297c4;--accent:#a97fff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px}
h1{font-size:20px;margin-bottom:20px}
.ring{width:240px;height:240px;border-radius:50%;border:6px solid var(--line);display:flex;align-items:center;justify-content:center;position:relative;margin-bottom:20px}
.ring .fill{position:absolute;inset:-6px;border-radius:50%;border:6px solid var(--accent);clip-path:polygon(50% 50%,50% 0,50% 0);transition:clip-path .3s linear}
.time{font-size:42px;font-weight:800;font-variant-numeric:tabular-nums;z-index:1}
.mode{color:var(--dim);font-size:13px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:16px}
.controls{display:flex;gap:10px}
button{background:var(--accent);color:#1c0f38;border:none;border-radius:9px;padding:11px 22px;font-weight:700;cursor:pointer;font-size:14px}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
.settings{display:flex;gap:14px;margin-top:22px;color:var(--dim);font-size:13px;align-items:center}
.settings input{width:50px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 7px;text-align:center}
.log{margin-top:24px;color:var(--dim);font-size:13px}
.log b{color:var(--accent)}
</style></head>
<body>
<h1>⏱️ Focus Timer</h1>
<div class="mode" id="mode">Work session</div>
<div class="ring"><div class="time" id="time">25:00</div></div>
<div class="controls">
  <button id="startBtn">Start</button>
  <button class="ghost" id="resetBtn">Reset</button>
</div>
<div class="settings">
  <span>Work <input id="workMin" type="number" value="25" min="1" max="90"> min</span>
  <span>Break <input id="breakMin" type="number" value="5" min="1" max="30"> min</span>
</div>
<div class="log">Completed sessions today: <b id="count">0</b></div>
<script>
let workSec=25*60,breakSec=5*60,remaining=workSec,onBreak=false,running=false,timer=null;
let count=+(localStorage.getItem("focusCount")||0);
document.getElementById("count").textContent=count;
function fmt(s){const m=Math.floor(s/60),sec=s%60;return String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0")}
function render(){
  document.getElementById("time").textContent=fmt(remaining);
  document.getElementById("mode").textContent=onBreak?"Break time":"Work session";
  document.getElementById("startBtn").textContent=running?"Pause":"Start";
}
function tick(){
  remaining--;
  if(remaining<=0){
    if(!onBreak){count++;localStorage.setItem("focusCount",count);document.getElementById("count").textContent=count;}
    onBreak=!onBreak;
    remaining=onBreak?breakSec:workSec;
  }
  render();
}
document.getElementById("startBtn").onclick=()=>{
  running=!running;
  if(running){timer=setInterval(tick,1000)}else{clearInterval(timer)}
  render();
};
document.getElementById("resetBtn").onclick=()=>{
  clearInterval(timer);running=false;onBreak=false;
  workSec=(+document.getElementById("workMin").value||25)*60;
  breakSec=(+document.getElementById("breakMin").value||5)*60;
  remaining=workSec;render();
};
document.getElementById("workMin").addEventListener("change",()=>{if(!running)document.getElementById("resetBtn").click()});
document.getElementById("breakMin").addEventListener("change",()=>{if(!running)document.getElementById("resetBtn").click()});
render();
</script></body></html>`,
  },
  {
    id: "expense-tracker",
    icon: "💰",
    name: "Expense Tracker",
    desc: "Log spending, see totals by category",
    prompt: "Build an expense tracker — let me log purchases with an amount and a category, and show totals broken down by category.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expense Tracker</title>
<style>
:root{--bg:#0f1512;--panel:#171f1a;--line:#28352c;--text:#eaf3ec;--dim:#8ba394;--accent:#4fd18b;--bad:#e0645c}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.wrap{max-width:520px;margin:0 auto}
h1{font-size:20px;margin-bottom:16px}
.total{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;text-align:center;margin-bottom:16px}
.total .big{font-size:32px;font-weight:800;color:var(--accent)}
.total .sub{color:var(--dim);font-size:12px;margin-top:2px}
form{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
input,select{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 10px;font-size:13px}
input[name=desc]{flex:2;min-width:120px}
input[name=amt]{flex:1;min-width:80px}
select{flex:1;min-width:100px}
button{background:var(--accent);color:#062112;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
.cats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.cat-pill{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:6px 12px;font-size:12px;color:var(--dim)}
.cat-pill b{color:var(--text)}
.item{display:flex;justify-content:space-between;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:6px;font-size:13px}
.item .desc{flex:1}
.item .cat{color:var(--dim);font-size:11px;margin-left:8px}
.item .amt{font-weight:700;font-family:monospace}
.item button{background:transparent;color:var(--bad);padding:2px 6px;margin-left:10px}
.empty{color:var(--dim);text-align:center;padding:30px;font-style:italic}
</style></head>
<body><div class="wrap">
<h1>💰 Expense Tracker</h1>
<div class="total"><div class="big" id="totalVal">$0.00</div><div class="sub">total spent</div></div>
<form id="form">
  <input name="desc" placeholder="What did you buy?" required>
  <input name="amt" type="number" step="0.01" min="0" placeholder="0.00" required>
  <select name="cat"><option>Food</option><option>Transport</option><option>Bills</option><option>Fun</option><option>Other</option></select>
  <button type="submit">Add</button>
</form>
<div class="cats" id="cats"></div>
<div id="list"></div>
</div>
<script>
let items=JSON.parse(localStorage.getItem("expenses")||"[]");
function save(){localStorage.setItem("expenses",JSON.stringify(items))}
function render(){
  const total=items.reduce((s,i)=>s+i.amt,0);
  document.getElementById("totalVal").textContent="$"+total.toFixed(2);
  const byCat={};
  items.forEach(i=>byCat[i.cat]=(byCat[i.cat]||0)+i.amt);
  document.getElementById("cats").innerHTML=Object.entries(byCat).map(([c,v])=>
    \`<div class="cat-pill">\${c}: <b>$\${v.toFixed(2)}</b></div>\`).join("")||"";
  const list=document.getElementById("list");
  if(!items.length){list.innerHTML='<div class="empty">No expenses logged yet.</div>';return}
  list.innerHTML=[...items].reverse().map((i,ri)=>{
    const idx=items.length-1-ri;
    return \`<div class="item"><span class="desc">\${i.desc}<span class="cat">\${i.cat}</span></span>
      <span class="amt">$\${i.amt.toFixed(2)}</span><button data-del="\${idx}">✕</button></div>\`;
  }).join("");
}
document.getElementById("form").addEventListener("submit",e=>{
  e.preventDefault();
  const f=e.target;
  items.push({desc:f.desc.value,amt:+f.amt.value,cat:f.cat.value});
  save();f.reset();render();
});
document.getElementById("list").addEventListener("click",e=>{
  const b=e.target.closest("[data-del]");if(!b)return;
  items.splice(+b.dataset.del,1);save();render();
});
render();
</script></body></html>`,
  },
  {
    id: "recipe-box",
    icon: "🍳",
    name: "Recipe Box",
    desc: "Save recipes with ingredients & steps",
    prompt: "Build a recipe box where I can save recipes with a list of ingredients and step-by-step instructions, and browse through them later.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recipe Box</title>
<style>
:root{--bg:#1c1512;--panel:#261c17;--line:#3d2b23;--text:#f7ede4;--dim:#b39a89;--accent:#e8813f}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,serif;background:var(--bg);color:var(--text);padding:24px}
.wrap{max-width:640px;margin:0 auto}
h1{font-size:24px;margin-bottom:16px}
.toolbar{display:flex;justify-content:space-between;margin-bottom:14px;align-items:center}
button{background:var(--accent);color:#2a1408;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer;font-family:inherit}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;cursor:pointer}
.card h3{font-size:16px;margin-bottom:4px}
.card p{color:var(--dim);font-size:12.5px}
.empty{color:var(--dim);text-align:center;padding:50px;font-style:italic}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);max-width:480px;width:100%;padding:0}
dialog::backdrop{background:rgba(0,0,0,.6)}
.form{padding:20px;display:flex;flex-direction:column;gap:10px}
.form input,.form textarea{background:#1c1512;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px}
.form textarea{min-height:80px}
.form label{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.view h2{margin-bottom:6px}
.view h4{margin:14px 0 6px;color:var(--accent);font-size:13px;text-transform:uppercase;letter-spacing:.4px}
.view pre{white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.6}
</style></head>
<body><div class="wrap">
<h1>🍳 Recipe Box</h1>
<div class="toolbar"><span id="countLbl"></span><button id="addBtn">+ New recipe</button></div>
<div class="grid" id="grid"></div>
</div>
<dialog id="editDlg"><form class="form" method="dialog" id="editForm">
  <label>Title</label><input id="f-title" required>
  <label>Ingredients (one per line)</label><textarea id="f-ing"></textarea>
  <label>Steps (one per line)</label><textarea id="f-steps"></textarea>
  <div class="form-actions"><button class="ghost" value="cancel" type="button" id="cancelBtn">Cancel</button><button value="save">Save</button></div>
</form></dialog>
<dialog id="viewDlg"><div class="form view">
  <h2 id="v-title"></h2>
  <h4>Ingredients</h4><pre id="v-ing"></pre>
  <h4>Steps</h4><pre id="v-steps"></pre>
  <div class="form-actions"><button class="ghost" id="deleteBtn">Delete</button><button id="closeViewBtn">Close</button></div>
</div></dialog>
<script>
let recipes=JSON.parse(localStorage.getItem("recipes")||"[]");
let viewIdx=null;
function save(){localStorage.setItem("recipes",JSON.stringify(recipes))}
function render(){
  document.getElementById("countLbl").textContent=recipes.length+" recipe"+(recipes.length===1?"":"s");
  const g=document.getElementById("grid");
  if(!recipes.length){g.innerHTML='<div class="empty">No recipes yet — add your first one.</div>';return}
  g.innerHTML=recipes.map((r,i)=>\`<div class="card" data-i="\${i}"><h3>\${r.title}</h3><p>\${r.ing.split("\\n").length} ingredients · \${r.steps.split("\\n").filter(Boolean).length} steps</p></div>\`).join("");
}
document.getElementById("addBtn").onclick=()=>{
  document.getElementById("editForm").reset();
  document.getElementById("editDlg").showModal();
};
document.getElementById("cancelBtn").onclick=()=>document.getElementById("editDlg").close();
document.getElementById("editForm").addEventListener("submit",e=>{
  recipes.push({title:document.getElementById("f-title").value,ing:document.getElementById("f-ing").value,steps:document.getElementById("f-steps").value});
  save();render();
});
document.getElementById("grid").addEventListener("click",e=>{
  const card=e.target.closest("[data-i]");if(!card)return;
  viewIdx=+card.dataset.i;const r=recipes[viewIdx];
  document.getElementById("v-title").textContent=r.title;
  document.getElementById("v-ing").textContent=r.ing;
  document.getElementById("v-steps").textContent=r.steps;
  document.getElementById("viewDlg").showModal();
});
document.getElementById("closeViewBtn").onclick=()=>document.getElementById("viewDlg").close();
document.getElementById("deleteBtn").onclick=()=>{
  recipes.splice(viewIdx,1);save();render();document.getElementById("viewDlg").close();
};
render();
</script></body></html>`,
  },
  {
    id: "todo-list",
    icon: "✅",
    name: "To-Do List",
    desc: "Tasks with priorities and due dates",
    prompt: "Build a to-do list with priorities (low/medium/high) and due dates, where I can check off tasks and overdue ones are highlighted.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>To-Do List</title>
<style>
:root{--bg:#101418;--panel:#181e24;--line:#2a333c;--text:#e8eef3;--dim:#93a1ad;--accent:#4fb3e8;--danger:#e0645c}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.wrap{max-width:520px;margin:0 auto}
h1{font-size:20px;margin-bottom:16px}
form{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
input,select{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 10px;font-size:13px}
input[name=title]{flex:2;min-width:140px}
button{background:var(--accent);color:#052233;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
.filters{display:flex;gap:6px;margin-bottom:12px}
.filters button{background:transparent;color:var(--dim);border:1px solid var(--line);padding:5px 12px;font-weight:400;font-size:12px}
.filters button.active{border-color:var(--accent);color:var(--accent)}
.task{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-bottom:6px}
.task.done .title{text-decoration:line-through;color:var(--dim)}
.task .title{flex:1;font-size:14px}
.prio{font-size:10px;padding:2px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:.3px}
.prio.high{background:#e0645c33;color:#f0a9a2}
.prio.med{background:#e8b04b33;color:#f3ce93}
.prio.low{background:#4fb3e833;color:#a6d9f3}
.due{font-size:11px;color:var(--dim)}
.task button{background:transparent;color:var(--danger);padding:2px 6px}
.empty{color:var(--dim);text-align:center;padding:30px;font-style:italic}
</style></head>
<body><div class="wrap">
<h1>✅ To-Do List</h1>
<form id="form">
  <input name="title" placeholder="New task…" required>
  <select name="prio"><option value="med">Medium</option><option value="high">High</option><option value="low">Low</option></select>
  <input name="due" type="date">
  <button type="submit">Add</button>
</form>
<div class="filters">
  <button data-f="all" class="active">All</button>
  <button data-f="open">Open</button>
  <button data-f="done">Done</button>
</div>
<div id="list"></div>
</div>
<script>
let tasks=JSON.parse(localStorage.getItem("todos")||"[]");
let filter="all";
function save(){localStorage.setItem("todos",JSON.stringify(tasks))}
function render(){
  const list=document.getElementById("list");
  const filtered=tasks.filter(t=>filter==="all"||(filter==="done"?t.done:!t.done));
  if(!filtered.length){list.innerHTML='<div class="empty">Nothing here.</div>';return}
  list.innerHTML=filtered.map(t=>{
    const idx=tasks.indexOf(t);
    return \`<div class="task \${t.done?"done":""}"><input type="checkbox" \${t.done?"checked":""} data-toggle="\${idx}">
      <span class="title">\${t.title}</span>
      <span class="prio \${t.prio}">\${t.prio}</span>
      \${t.due?'<span class="due">'+t.due+'</span>':""}
      <button data-del="\${idx}">✕</button></div>\`;
  }).join("");
}
document.getElementById("form").addEventListener("submit",e=>{
  e.preventDefault();const f=e.target;
  tasks.push({title:f.title.value,prio:f.prio.value,due:f.due.value,done:false});
  save();f.reset();render();
});
document.querySelector(".filters").addEventListener("click",e=>{
  const b=e.target.closest("[data-f]");if(!b)return;
  filter=b.dataset.f;
  document.querySelectorAll(".filters button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");render();
});
document.getElementById("list").addEventListener("click",e=>{
  const t=e.target.closest("[data-toggle]");
  if(t){tasks[+t.dataset.toggle].done=t.checked;save();render();return}
  const d=e.target.closest("[data-del]");
  if(d){tasks.splice(+d.dataset.del,1);save();render()}
});
render();
</script></body></html>`,
  },
  {
    id: "password-generator",
    icon: "🔐",
    name: "Password Generator",
    desc: "Strong random passwords, copy to clipboard",
    prompt: "Build a password generator — let me pick the length and whether to include symbols and numbers, generate a strong random password, and copy it with one click.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Password Generator</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#2a313c;--text:#e6edf3;--dim:#8b98a5;--accent:#3fb950}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px;width:100%;max-width:420px}
h1{font-size:19px;margin-bottom:16px}
.output{display:flex;gap:8px;margin-bottom:18px}
.output input{flex:1;background:#0a0e13;border:1px solid var(--line);color:var(--accent);border-radius:8px;padding:11px;font-family:monospace;font-size:15px;letter-spacing:1px}
.output button{background:var(--accent);color:#04240a;border:none;border-radius:8px;padding:0 14px;font-weight:700;cursor:pointer}
.strength{height:5px;border-radius:3px;background:var(--line);margin-bottom:18px;overflow:hidden}
.strength .fill{height:100%;width:0;transition:width .2s,background .2s}
.opt{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:14px;border-bottom:1px solid var(--line)}
.opt:last-of-type{border-bottom:none}
input[type=range]{width:140px}
.regen{width:100%;margin-top:18px;background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:8px;padding:11px;font-weight:700;cursor:pointer}
.copied{text-align:center;color:var(--accent);font-size:12px;margin-top:8px;height:14px}
</style></head>
<body><div class="card">
<h1>🔐 Password Generator</h1>
<div class="output"><input id="out" readonly><button id="copyBtn">Copy</button></div>
<div class="strength"><div class="fill" id="strengthFill"></div></div>
<div class="opt"><span>Length: <b id="lenLbl">16</b></span><input type="range" id="len" min="6" max="48" value="16"></div>
<div class="opt"><span>Uppercase (A-Z)</span><input type="checkbox" id="upper" checked></div>
<div class="opt"><span>Lowercase (a-z)</span><input type="checkbox" id="lower" checked></div>
<div class="opt"><span>Numbers (0-9)</span><input type="checkbox" id="nums" checked></div>
<div class="opt"><span>Symbols (!@#...)</span><input type="checkbox" id="syms" checked></div>
<button class="regen" id="regenBtn">Generate new password</button>
<div class="copied" id="copiedMsg"></div>
</div>
<script>
const SETS={upper:"ABCDEFGHIJKLMNOPQRSTUVWXYZ",lower:"abcdefghijklmnopqrstuvwxyz",nums:"0123456789",syms:"!@#$%^&*()-_=+[]{};:,.<>?"};
function generate(){
  const len=+document.getElementById("len").value;
  let pool="";
  ["upper","lower","nums","syms"].forEach(k=>{if(document.getElementById(k).checked)pool+=SETS[k]});
  if(!pool){pool=SETS.lower}
  const arr=new Uint32Array(len);
  crypto.getRandomValues(arr);
  let pass="";
  for(let i=0;i<len;i++)pass+=pool[arr[i]%pool.length];
  document.getElementById("out").value=pass;
  const active=["upper","lower","nums","syms"].filter(k=>document.getElementById(k).checked).length;
  const score=Math.min(100,(len/32)*50+active*12.5);
  const fill=document.getElementById("strengthFill");
  fill.style.width=score+"%";
  fill.style.background=score<40?"#e0645c":score<70?"#e8b04b":"#3fb950";
}
document.getElementById("len").addEventListener("input",e=>{document.getElementById("lenLbl").textContent=e.target.value;generate()});
["upper","lower","nums","syms"].forEach(k=>document.getElementById(k).addEventListener("change",generate));
document.getElementById("regenBtn").onclick=generate;
document.getElementById("copyBtn").onclick=()=>{
  navigator.clipboard.writeText(document.getElementById("out").value);
  document.getElementById("copiedMsg").textContent="✓ Copied to clipboard";
  setTimeout(()=>document.getElementById("copiedMsg").textContent="",2000);
};
generate();
</script></body></html>`,
  },
  {
    id: "unit-converter",
    icon: "📐",
    name: "Unit Converter",
    desc: "Length, weight, and temperature",
    prompt: "Build a unit converter for length, weight, and temperature — pick a unit, type a value, and see it converted to other common units instantly.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unit Converter</title>
<style>
:root{--bg:#12181c;--panel:#1a2227;--line:#2c383e;--text:#e9f2f4;--dim:#8ea2a8;--accent:#38c6d9}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px;width:100%;max-width:420px}
h1{font-size:19px;margin-bottom:16px}
.tabs{display:flex;gap:6px;margin-bottom:18px}
.tabs button{flex:1;background:transparent;border:1px solid var(--line);color:var(--dim);padding:8px;border-radius:8px;cursor:pointer;font-size:13px}
.tabs button.active{border-color:var(--accent);color:var(--accent)}
.row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.row input{flex:1;background:#0e1418;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px;font-size:16px;font-family:monospace}
.row select{background:#0e1418;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px;font-size:13px}
.swap{text-align:center;color:var(--dim);font-size:18px;margin:6px 0;cursor:pointer}
</style></head>
<body><div class="card">
<h1>📐 Unit Converter</h1>
<div class="tabs">
  <button data-c="length" class="active">Length</button>
  <button data-c="weight">Weight</button>
  <button data-c="temp">Temperature</button>
</div>
<div class="row"><input id="fromVal" type="number" value="1"><select id="fromUnit"></select></div>
<div class="swap" id="swapBtn">⇅ swap</div>
<div class="row"><input id="toVal" readonly><select id="toUnit"></select></div>
</div>
<script>
const UNITS={
  length:{m:1,km:1000,cm:0.01,mm:0.001,mi:1609.34,yd:0.9144,ft:0.3048,in:0.0254},
  weight:{kg:1,g:0.001,mg:0.000001,lb:0.453592,oz:0.0283495,ton:1000},
  temp:{C:"C",F:"F",K:"K"}
};
let category="length";
function populate(){
  const keys=Object.keys(UNITS[category]);
  document.getElementById("fromUnit").innerHTML=keys.map(k=>\`<option value="\${k}">\${k}</option>\`).join("");
  document.getElementById("toUnit").innerHTML=keys.map((k,i)=>\`<option value="\${k}" \${i===1?"selected":""}>\${k}</option>\`).join("");
  convert();
}
function tempConvert(v,from,to){
  let c=from==="C"?v:from==="F"?(v-32)*5/9:v-273.15;
  return to==="C"?c:to==="F"?c*9/5+32:c+273.15;
}
function convert(){
  const v=+document.getElementById("fromVal").value||0;
  const from=document.getElementById("fromUnit").value,to=document.getElementById("toUnit").value;
  let result;
  if(category==="temp"){result=tempConvert(v,from,to)}
  else{const base=UNITS[category];result=v*base[from]/base[to]}
  document.getElementById("toVal").value=Math.round(result*10000)/10000;
}
document.querySelector(".tabs").addEventListener("click",e=>{
  const b=e.target.closest("[data-c]");if(!b)return;
  category=b.dataset.c;
  document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");populate();
});
document.getElementById("fromVal").addEventListener("input",convert);
document.getElementById("fromUnit").addEventListener("change",convert);
document.getElementById("toUnit").addEventListener("change",convert);
document.getElementById("swapBtn").onclick=()=>{
  const fu=document.getElementById("fromUnit"),tu=document.getElementById("toUnit");
  [fu.value,tu.value]=[tu.value,fu.value];convert();
};
populate();
</script></body></html>`,
  },
  {
    id: "countdown-timer",
    icon: "🎉",
    name: "Countdown Timer",
    desc: "Count down to any date or event",
    prompt: "Build a countdown timer to a date and time I pick, showing days, hours, minutes, and seconds remaining, updating live.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Countdown</title>
<style>
:root{--bg:#170e1c;--panel:#221530;--line:#3a2650;--text:#f5eefd;--dim:#b09fd0;--accent:#ff6fa5}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px}
h1{font-size:19px;margin-bottom:16px}
form{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;justify-content:center}
input{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px 11px;font-size:13px}
button{background:var(--accent);color:#2c0a19;border:none;border-radius:8px;padding:9px 16px;font-weight:700;cursor:pointer}
.units{display:flex;gap:14px}
.unit{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 22px;text-align:center;min-width:80px}
.unit .n{font-size:32px;font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
.unit .l{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:4px}
.label{margin-top:18px;color:var(--dim);font-size:14px}
.done{font-size:22px;color:var(--accent);margin-top:20px}
</style></head>
<body>
<h1>🎉 Countdown Timer</h1>
<form id="form">
  <input id="eventName" placeholder="Event name" value="New Year">
  <input id="eventDate" type="datetime-local">
  <button type="submit">Set countdown</button>
</form>
<div class="units" id="units">
  <div class="unit"><div class="n" id="d">0</div><div class="l">days</div></div>
  <div class="unit"><div class="n" id="h">0</div><div class="l">hrs</div></div>
  <div class="unit"><div class="n" id="m">0</div><div class="l">min</div></div>
  <div class="unit"><div class="n" id="s">0</div><div class="l">sec</div></div>
</div>
<div class="label" id="label"></div>
<script>
let target=localStorage.getItem("countdownTarget");
let name=localStorage.getItem("countdownName")||"New Year";
if(!target){const d=new Date();d.setMonth(11,31);d.setHours(23,59,0,0);target=d.toISOString()}
document.getElementById("eventName").value=name;
document.getElementById("eventDate").value=target.slice(0,16);
function tick(){
  const diff=new Date(target)-new Date();
  document.getElementById("label").textContent="Counting down to: "+name;
  if(diff<=0){
    document.getElementById("units").style.display="none";
    document.getElementById("label").innerHTML="🎉 "+name+" is here!";
    return;
  }
  document.getElementById("units").style.display="flex";
  document.getElementById("d").textContent=Math.floor(diff/86400000);
  document.getElementById("h").textContent=Math.floor(diff/3600000)%24;
  document.getElementById("m").textContent=Math.floor(diff/60000)%60;
  document.getElementById("s").textContent=Math.floor(diff/1000)%60;
}
document.getElementById("form").addEventListener("submit",e=>{
  e.preventDefault();
  target=new Date(document.getElementById("eventDate").value).toISOString();
  name=document.getElementById("eventName").value||"Event";
  localStorage.setItem("countdownTarget",target);
  localStorage.setItem("countdownName",name);
  tick();
});
setInterval(tick,1000);tick();
</script></body></html>`,
  },
  {
    id: "budget-planner",
    icon: "📊",
    name: "Budget Planner",
    desc: "Plan monthly income vs. expenses",
    prompt: "Build a monthly budget planner — let me enter my income and a list of expenses, and see what's left over at a glance.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Budget Planner</title>
<style>
:root{--bg:#0f131c;--panel:#171d2a;--line:#2a3244;--text:#e8ecf5;--dim:#8f98ac;--accent:#5ac8fa;--bad:#e0645c;--good:#4fd18b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.wrap{max-width:520px;margin:0 auto}
h1{font-size:20px;margin-bottom:16px}
.summary{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:18px}
.summary .box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;text-align:center}
.summary .box .v{font-size:18px;font-weight:800;font-family:monospace}
.summary .box .l{color:var(--dim);font-size:11px;margin-top:2px;text-transform:uppercase;letter-spacing:.3px}
.summary .box.income .v{color:var(--good)}
.summary .box.expense .v{color:var(--bad)}
.summary .box.left .v{color:var(--accent)}
h2{font-size:14px;color:var(--dim);margin:18px 0 8px;text-transform:uppercase;letter-spacing:.4px}
form{display:flex;gap:8px;margin-bottom:10px}
input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px}
button{background:var(--accent);color:#04222f;border:none;border-radius:8px;padding:8px 14px;font-weight:700;cursor:pointer}
.line{display:flex;justify-content:space-between;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:6px;font-size:13px}
.line button{background:transparent;color:var(--bad);padding:0 4px}
.empty{color:var(--dim);font-size:12px;font-style:italic;padding:8px 0}
</style></head>
<body><div class="wrap">
<h1>📊 Budget Planner</h1>
<div class="summary">
  <div class="box income"><div class="v" id="incomeTotal">$0</div><div class="l">Income</div></div>
  <div class="box expense"><div class="v" id="expenseTotal">$0</div><div class="l">Expenses</div></div>
  <div class="box left"><div class="v" id="leftTotal">$0</div><div class="l">Remaining</div></div>
</div>
<h2>Income</h2>
<form data-type="income"><input name="name" placeholder="Source, e.g. Salary" required><input name="amt" type="number" step="0.01" placeholder="0.00" required><button>Add</button></form>
<div id="incomeList"></div>
<h2>Expenses</h2>
<form data-type="expense"><input name="name" placeholder="Item, e.g. Rent" required><input name="amt" type="number" step="0.01" placeholder="0.00" required><button>Add</button></form>
<div id="expenseList"></div>
</div>
<script>
let data=JSON.parse(localStorage.getItem("budget")||'{"income":[],"expense":[]}');
function save(){localStorage.setItem("budget",JSON.stringify(data))}
function renderList(type){
  const el=document.getElementById(type+"List");
  const items=data[type];
  if(!items.length){el.innerHTML='<div class="empty">Nothing added yet.</div>';return}
  el.innerHTML=items.map((it,i)=>\`<div class="line"><span>\${it.name}</span><span>$\${it.amt.toFixed(2)} <button data-type="\${type}" data-i="\${i}">✕</button></span></div>\`).join("");
}
function renderTotals(){
  const inc=data.income.reduce((s,i)=>s+i.amt,0);
  const exp=data.expense.reduce((s,i)=>s+i.amt,0);
  document.getElementById("incomeTotal").textContent="$"+inc.toFixed(2);
  document.getElementById("expenseTotal").textContent="$"+exp.toFixed(2);
  document.getElementById("leftTotal").textContent="$"+(inc-exp).toFixed(2);
}
function renderAll(){renderList("income");renderList("expense");renderTotals()}
document.querySelectorAll("form").forEach(f=>f.addEventListener("submit",e=>{
  e.preventDefault();
  const type=f.dataset.type;
  data[type].push({name:f.name.value,amt:+f.amt.value});
  save();f.reset();renderAll();
}));
document.body.addEventListener("click",e=>{
  const b=e.target.closest("[data-type][data-i]");if(!b)return;
  data[b.dataset.type].splice(+b.dataset.i,1);save();renderAll();
});
renderAll();
</script></body></html>`,
  },
  {
    id: "contact-book",
    icon: "📇",
    name: "Contact Book",
    desc: "Save names, numbers, and notes",
    prompt: "Build a contact book where I can save names, phone numbers, and notes for each person, and search through them.",
    code: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contact Book</title>
<style>
:root{--bg:#141118;--panel:#1e1a24;--line:#332c3d;--text:#f1edf6;--dim:#a297ae;--accent:#c792ea}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.wrap{max-width:520px;margin:0 auto}
h1{font-size:20px;margin-bottom:16px}
.search{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
button.add{width:100%;background:var(--accent);color:#221733;border:none;border-radius:8px;padding:10px;font-weight:700;cursor:pointer;margin-bottom:16px}
.contact{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:8px}
.contact .top{display:flex;justify-content:space-between;align-items:center}
.contact .name{font-weight:700;font-size:14px}
.contact .avatar{width:34px;height:34px;border-radius:50%;background:var(--accent);color:#221733;display:flex;align-items:center;justify-content:center;font-weight:800;margin-right:10px}
.contact .row{display:flex;align-items:center}
.contact .info{color:var(--dim);font-size:12px;margin-top:4px}
.contact button{background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer}
.empty{color:var(--dim);text-align:center;padding:40px;font-style:italic}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);max-width:380px;width:100%;padding:0}
dialog::backdrop{background:rgba(0,0,0,.6)}
.form{padding:20px;display:flex;flex-direction:column;gap:10px}
.form input,.form textarea{background:#141118;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 10px;font-family:inherit;font-size:13px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.form-actions button{background:var(--accent);color:#221733;border:none;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer}
.form-actions button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
</style></head>
<body><div class="wrap">
<h1>📇 Contact Book</h1>
<input class="search" id="search" placeholder="Search contacts…">
<button class="add" id="addBtn">+ New contact</button>
<div id="list"></div>
</div>
<dialog id="dlg"><form class="form" method="dialog" id="form">
  <input id="f-name" placeholder="Name" required>
  <input id="f-phone" placeholder="Phone">
  <input id="f-email" placeholder="Email" type="email">
  <textarea id="f-notes" placeholder="Notes"></textarea>
  <div class="form-actions"><button class="ghost" type="button" id="cancelBtn">Cancel</button><button value="save">Save</button></div>
</form></dialog>
<script>
let contacts=JSON.parse(localStorage.getItem("contacts")||"[]");
function save(){localStorage.setItem("contacts",JSON.stringify(contacts))}
function render(){
  const q=document.getElementById("search").value.toLowerCase();
  const filtered=contacts.map((c,i)=>({...c,i})).filter(c=>c.name.toLowerCase().includes(q));
  const list=document.getElementById("list");
  if(!filtered.length){list.innerHTML='<div class="empty">No contacts found.</div>';return}
  list.innerHTML=filtered.sort((a,b)=>a.name.localeCompare(b.name)).map(c=>
    \`<div class="contact"><div class="top"><div class="row"><div class="avatar">\${c.name[0].toUpperCase()}</div>
      <div><div class="name">\${c.name}</div><div class="info">\${c.phone||""} \${c.email?"· "+c.email:""}</div></div></div>
      <button data-del="\${c.i}">Delete</button></div>
      \${c.notes?'<div class="info" style="margin-top:8px">'+c.notes+'</div>':""}</div>\`
  ).join("");
}
document.getElementById("search").addEventListener("input",render);
document.getElementById("addBtn").onclick=()=>{document.getElementById("form").reset();document.getElementById("dlg").showModal()};
document.getElementById("cancelBtn").onclick=()=>document.getElementById("dlg").close();
document.getElementById("form").addEventListener("submit",()=>{
  contacts.push({name:document.getElementById("f-name").value,phone:document.getElementById("f-phone").value,email:document.getElementById("f-email").value,notes:document.getElementById("f-notes").value});
  save();render();
});
document.getElementById("list").addEventListener("click",e=>{
  const b=e.target.closest("[data-del]");if(!b)return;
  contacts.splice(+b.dataset.del,1);save();render();
});
render();
</script></body></html>`,
  },
];
