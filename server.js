const http = require("node:http");
const PORT = Number(process.env.PORT || 3000);
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://cambridge-saga.onrender.com";
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const rate = new Map();
const WINDOW = 60000, LIMIT = 8, MAX_BODY = 22000;
function reply(res, code, data, origin) {
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Access-Control-Allow-Origin":origin || SITE_ORIGIN,"Vary":"Origin"});
  res.end(JSON.stringify(data));
}
function clean(v,n){return typeof v === "string" ? v.trim().slice(0,n) : "";}
const app = http.createServer(async (req,res) => {
  const origin = req.headers.origin || "";
  const allowed = origin === SITE_ORIGIN || origin === "http://localhost:3000" || origin === "http://127.0.0.1:5500";
  if(req.method === "OPTIONS"){
    if(!allowed) return reply(res,403,{error:"Origin not allowed."},SITE_ORIGIN);
    res.writeHead(204,{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"600","Vary":"Origin"}); return res.end();
  }
  if(req.url === "/health" && req.method === "GET") return reply(res,200,{ok:true,service:"cambridge-saga-assessment",aiConfigured:Boolean(API_KEY)},allowed?origin:SITE_ORIGIN);
  if(req.url !== "/api/assess" || req.method !== "POST") return reply(res,404,{error:"Not found."},allowed?origin:SITE_ORIGIN);
  if(!allowed) return reply(res,403,{error:"Origin not allowed."},SITE_ORIGIN);
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now(); let slot = rate.get(ip) || {start:now,count:0};
  if(now-slot.start>WINDOW){slot={start:now,count:0};} slot.count++; rate.set(ip,slot);
  if(slot.count>LIMIT) return reply(res,429,{error:"Too many requests. Please wait one minute."},origin);
  let raw="";
  try {
    for await (const chunk of req) { raw += chunk; if(raw.length>MAX_BODY) return reply(res,413,{error:"Response is too long. Please shorten it."},origin); }
    const body=JSON.parse(raw||"{}");
    const kind=body.kind==="writing"?"writing":body.kind==="speaking"?"speaking":"";
    const response=clean(body.response,12000), prompt=clean(body.prompt,1200), task=clean(body.task,80);
    if(!kind || response.length<30) return reply(res,400,{error:"Provide a writing or speaking response of at least 30 characters."},origin);
    if(!API_KEY) return reply(res,503,{error:"AI assessment is not configured. Add OPENAI_API_KEY in the Render backend environment to enable it."},origin);
    const criteria=kind==="writing"
      ? ["Task Achievement/Task Response","Coherence and Cohesion","Lexical Resource","Grammatical Range and Accuracy"]
      : ["Fluency and Coherence","Lexical Resource","Grammatical Range and Accuracy","Pronunciation"];
    const instructions=[
      "You provide cautious IELTS-style learning feedback, not an official IELTS result. Assess only the submitted answer and the task. Return a single JSON object.",
      "Required keys: estimatedOverallBand (number from 0 to 9 in half bands or null), criteria (array of objects with name, estimatedBand (number or null), evidence (short string), improvements (array of two short strings)), strengths (array of two strings), nextSteps (array of three strings), limitations (string).",
      "Use IELTS public band-descriptor concepts cautiously. If the evidence is insufficient, use null instead of inventing precision. An overall estimate is a practice estimate only.",
      "For speaking, the submitted content may be a transcript, not audio. Set the Pronunciation estimatedBand to null and explain that transcript text cannot assess pronunciation.",
      "Module: "+kind+". Task: "+task+". Prompt: "+prompt+". Criteria: "+criteria.join("; ")+". Learner response: "+response
    ].join("\n");
    const upstream=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"Authorization":"Bearer "+API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,input:instructions,text:{format:{type:"json_object"}},max_output_tokens:1300})});
    const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok){console.error("Assessment provider returned status",upstream.status);return reply(res,502,{error:"Assessment is temporarily unavailable. Please try again later."},origin);}
    const output=(data.output||[]).flatMap(x=>x.content||[]).find(x=>x.type==="output_text")?.text||data.output_text||"";
    let assessment; try{assessment=JSON.parse(output);}catch{return reply(res,502,{error:"Could not read the assessment response. Please retry."},origin);}
    return reply(res,200,{assessment,disclaimer:"Unofficial practice feedback only. This is not an IELTS result."},origin);
  } catch(err) { console.error("Request processing error:",err.message); return reply(res,400,{error:"Could not process the request. Check your response and try again."},origin||SITE_ORIGIN); }
});
app.listen(PORT,"0.0.0.0",()=>console.log("Cambridge Saga assessment service listening on "+PORT));
