import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeSession, translateByPriority } from '../public/translation-priority.js';
import { parseTimedSubtitles } from '../public/subtitle-files.js';
import translateHandler from '../api/translate.js';
import captionsHandler from '../api/captions.js';
import fs from 'node:fs';
import vm from 'node:vm';

const source = ['This is the first sentence.', 'This is the second sentence.'];
const magyar = ['Ez az első mondat.', 'Ez a második mondat.'];
function res() {
  return { code: 200, headers: {}, setHeader(k,v) { this.headers[k]=v; },
    status(n) { this.code=n; return this; }, json(body) { this.body=body; return this; }, end() { return this; } };
}
const blocked = () => new Response(JSON.stringify({
  playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" }
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Chrome is first; successful local translation never calls remote providers', async () => {
  const calls=[];
  const result=await translateByPriority(source, {
    chromeTranslate: async () => { calls.push('chrome'); return { translations: magyar }; },
    googleTranslate: async () => { throw new Error('Google must not be called'); },
    deepLTranslate: async () => { throw new Error('DeepL must not be called'); }
  });
  assert.deepEqual(calls,['chrome']); assert.deepEqual(result.translations,magyar);
  assert.equal(result.engine,'chrome');
});

test('mobile without Translator uses free Google and never needs a DeepL key', async () => {
  assert.equal(await createChromeSession('en', { api: null }),null);
  const result=await translateByPriority(source,{ googleTranslate: async () => ({ translations:magyar }) });
  assert.equal(result.engine,'google_free'); assert.equal(result.failed,0);
});

test('DeepL receives only lines the primary translators failed to translate', async () => {
  const calls=[];
  const result=await translateByPriority(source, {
    chromeTranslate: async () => { throw new Error('unavailable'); },
    googleTranslate: async () => ({translations:[magyar[0],source[1]]}),
    deepLTranslate: async (lines) => { calls.push(lines); return {translations:[magyar[1]]}; }
  });
  assert.deepEqual(calls,[[source[1]]]); assert.deepEqual(result.translations,magyar);
  assert.deepEqual(result.engines,['google_free','deepl']);
});

test('abort stops the chain before DeepL', async () => {
  const controller=new AbortController(); let deepLCalls=0;
  await assert.rejects(translateByPriority(source, {
    signal:controller.signal,
    googleTranslate:async()=>{ controller.abort(); throw new Error('stopped'); },
    deepLTranslate:async()=>{ deepLCalls++; return {translations:magyar}; }
  }),{name:'AbortError'});
  assert.equal(deepLCalls,0);
});

test('missing DeepL key makes no outbound requests; legacy paid engines are rejected', async (t) => {
  t.mock.method(globalThis,'fetch',async()=>{ throw new Error('No request permitted'); });
  for(const engine of ['gemini','openai','deepl']) {
    const out=res(); await translateHandler({method:'POST',body:{engine,texts:source}},out);
    assert.ok(out.code>=400);
  }
  assert.equal(globalThis.fetch.mock.callCount(),0);
});

test('DeepL uses the selected account endpoint, preserves alignment and never logs the key', async (t) => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify({translations:magyar.map(text=>({text}))}),{status:200});
  });
  for(const [plan,host] of [['legacy_free','api-free.deepl.com'],['developer','api.deepl.com']]) {
    const out=res(); await translateHandler({method:'POST',body:{engine:'deepl',texts:source,
      deeplKey:'fixture-secret',deeplPlan:plan}},out);
    assert.equal(out.code,200); assert.deepEqual(out.body.translations,magyar);
    assert.equal(new URL(calls.at(-1).url).hostname,host);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body),{text:source,target_lang:'HU'});
    assert.ok(!JSON.stringify(out).includes('fixture-secret'));
  }
});

test('DeepL quota failure is JSON and never starts another engine or paid fallback', async (t) => {
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:456}));
  const out=res(); await translateHandler({method:'POST',body:{engine:'deepl',texts:source,
    deeplKey:'fixture-secret',deeplPlan:'developer'}},out);
  assert.equal(out.code,502); assert.match(out.body.error,/karakterkerete/);
  assert.equal(globalThis.fetch.mock.callCount(),1);
});

test('stored Supadata key never authorizes automatic credit usage', async (t) => {
  const previous=process.env.SUPADATA_API_KEY;
  process.env.SUPADATA_API_KEY='fixture-secret';
  t.after(()=>{
    if(previous===undefined) delete process.env.SUPADATA_API_KEY;
    else process.env.SUPADATA_API_KEY=previous;
  });
  const urls=[];
  t.mock.method(console,'warn',()=>{});
  t.mock.method(globalThis,'fetch',async(url)=>{ urls.push(String(url)); return blocked(); });
  for(const flag of [undefined,false,'true']) {
    const out=res(); await captionsHandler({method:'POST',body:{videoId:'dQw4w9WgXcQ',
      useSupadata:flag,supadataKey:'fixture-secret'}},out);
    assert.equal(out.code,502); assert.equal(out.body.reason,'youtube_blocked');
    assert.equal(out.body.canUseFallback,true);
  }
  assert.equal(urls.filter(url=>url.includes('supadata.ai')).length,0);
});

test('explicit Supadata opt-in fetches only existing captions, without AI generation', async (t) => {
  const urls=[]; t.mock.method(console,'warn',()=>{}); t.mock.method(console,'log',()=>{});
  t.mock.method(globalThis,'fetch',async(url)=>{
    urls.push(String(url));
    if(String(url).includes('supadata.ai')) return new Response(JSON.stringify({lang:'en',
      content:[{offset:1000,duration:2000,text:source[0]}]}),{status:200});
    return blocked();
  });
  const out=res(); await captionsHandler({method:'POST',body:{videoId:'dQw4w9WgXcQ',
    useSupadata:true,supadataKey:'fixture-secret'}},out);
  assert.equal(out.code,200); assert.equal(out.body.source,'supadata');
  const request=new URL(urls.find(url=>url.includes('supadata.ai')));
  assert.equal(request.searchParams.get('mode'),'native');
});

test('real frontend boots against its HTML and translates without old AI keys or credit fallback', async () => {
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
  const nodes=new Map();
  const element=(fragment=false)=>({fragment,children:[],style:{},dataset:{},hidden:false,
    value:'',textContent:'',events:{},classList:{add(){},remove(){},toggle(){}},
    addEventListener(type,fn){this.events[type]=fn;},
    appendChild(child){this.children.push(...(child.fragment?child.children:[child]));},
    replaceChildren(...children){this.children=children;},
    querySelector(){return element();},scrollIntoView(){},focus(){},
    set innerHTML(value){this._html=value;if(!value)this.children=[];},get innerHTML(){return this._html||'';}
  });
  const document={
    getElementById(id){assert.ok(ids.has(id),'Missing HTML element '+id);
      if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
    createElement(){return element();},createDocumentFragment(){return element(true);},
    addEventListener(){},title:'HU Felirat'
  };
  const saved=new Map([['hufelirat_auto_settings_v2',JSON.stringify({
    engine:'openai',apiKey:'old-paid-key',supadataKey:'optional-credit-key'
  })]]);
  const navigator={};
  const playerConfigurations=[];
  const YT={Player:function(id,options){playerConfigurations.push(options.playerVars);
    return{loadVideoById(){},destroy(){}};}};
  const window={YT,navigator,location:{search:''},history:{replaceState(){}},
    matchMedia:()=>({matches:false}),addEventListener(){}};
  const requests=[];
  const context=vm.createContext({document,window,navigator,YT,URLSearchParams,
    AbortController,console,setTimeout,clearTimeout,setInterval,clearInterval,
    createChromeSession,translateByPriority,parseTimedSubtitles,
    localStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)},
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(url==='/api/captions') return new Response(JSON.stringify({title:'Fixture',
        selectedTrack:{langCode:'en',langName:'English'},tracks:[],
        cues:[{start:0,end:2,text:source[0]}]}));
      assert.ok(String(url).startsWith('https://translate.googleapis.com/'));
      return new Response(JSON.stringify([[[magyar[0],source[0]]]]));
    }
  });
  const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8')
    .replace(/^import[^\n]+\n/gm,'');
  new vm.Script(app+'\nglobalThis.appUnderTest={state,loadVideoFromInput,importSubtitleText,useNativeCaptions};').runInContext(context);
  assert.equal(context.appUnderTest.state.ytApiReady,true,'Already loaded YouTube API must be detected');
  await context.appUnderTest.loadVideoFromInput('dQw4w9WgXcQ');
  assert.equal(context.appUnderTest.state.cues[0].translated,magyar[0]);
  const request=JSON.parse(requests[0].options.body);
  assert.equal(request.useSupadata,false);assert.equal(request.supadataKey,undefined);
  assert.ok(!JSON.stringify(requests).includes('old-paid-key'));
  assert.ok(nodes.get('statusText').textContent.includes('Kész'));

  // Importing timed text translates without repeating the blocked caption request.
  const beforeImport=requests.length;
  await context.appUnderTest.importSubtitleText('1\n00:00:00,000 --> 00:00:04,000\n'+source[0],'en');
  assert.equal(requests.length,beforeImport+1);
  assert.equal(requests.at(-1).url.startsWith('https://translate.googleapis.com/'),true);
  assert.equal(context.appUnderTest.state.cues[0].translated,magyar[0]);
  assert.equal(nodes.get('freeOptions').hidden,false);
  const hungarian='1\n00:00:00,000 --> 00:00:04,000\nMár magyar felirat.';
  const beforeHungarian=requests.length;
  await context.appUnderTest.importSubtitleText(hungarian,'hu');
  assert.equal(requests.length,beforeHungarian,'Existing Hungarian subtitles need no external call');
  context.appUnderTest.useNativeCaptions();
  assert.equal(requests.length,beforeHungarian,'Native YouTube mode must not invoke caption providers');
  assert.equal(nodes.get('subtitleStage').hidden,true);
  assert.equal(playerConfigurations.at(-1).cc_load_policy,1);
  assert.equal(playerConfigurations.at(-1).cc_lang_pref,'hu');
  await context.appUnderTest.importSubtitleText(hungarian,'hu');
  assert.equal(nodes.get('subtitleStage').hidden,false);
  assert.equal(playerConfigurations.at(-1).cc_load_policy,0);
  assert.equal(context.appUnderTest.state.cues[0].translated,'Már magyar felirat.');

  // An old server response must never overwrite a locally imported subtitle.
  const previousFetch=context.fetch;
  let finishRequest;
  context.fetch=async(url,options)=>url==='/api/captions'
    ? await new Promise(resolve=>{finishRequest=resolve;}) : previousFetch(url,options);
  nodes.get('urlInput').value='https://youtu.be/dQw4w9WgXcQ';
  const pending=context.appUnderTest.loadVideoFromInput('dQw4w9WgXcQ');
  await context.appUnderTest.importSubtitleText(hungarian,'hu');
  finishRequest(new Response(JSON.stringify({selectedTrack:{langCode:'en'},tracks:[],
    cues:[{start:0,end:1,text:'Stale server text'}]})));
  await pending;
  assert.equal(context.appUnderTest.state.cues[0].translated,'Már magyar felirat.');
});

