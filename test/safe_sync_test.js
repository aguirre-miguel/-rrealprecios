/* Prueba local de la sincronización segura (SAFE-SYNC). NO toca Supabase real:
   el "servidor" es un objeto en memoria que imita la API REST de PostgREST.
   Correr desde la raíz del repo:  sh test/run_safe_sync_test.sh
   (usa el motor JavaScriptCore que ya viene en macOS; no instala nada) */
var SRC = readFile('index.html');
function region(){ var a=SRC.indexOf('// SAFE-SYNC:BEGIN'), b=SRC.indexOf('// SAFE-SYNC:END'); if(a<0||b<0) throw new Error('marcadores SAFE-SYNC no encontrados'); return SRC.slice(a,b); }
function fnSrc(name){
  var i=SRC.indexOf('function '+name+'('); if(i<0) throw new Error('no encontré '+name);
  var depth=0, j=SRC.indexOf('{',i), str=null;
  for(var k=j;k<SRC.length;k++){ var c=SRC[k];
    if(str){ if(c==='\\'){k++;continue;} if(c===str)str=null; continue; }
    if(c==="'"||c==='"'||c==='`'){ str=c; continue; }
    if(c==='{')depth++; else if(c==='}'){ depth--; if(depth===0) return SRC.slice(i,k+1); } }
  throw new Error('llaves sin cerrar en '+name);
}
var APP = ['coKeys','coPick','normalizeCompanies','_editEntry','saveCustomProducts','loadCustomProducts','normalizeProteinUnits'].map(fnSrc).join('\n')+'\n'+region();

/* ---------- servidor falso (PostgREST) ---------- */
var SERVER = { row:null, calls:[], beforeWrite:null, patchStatus:200 };
function resp(status, body){ return { ok: status>=200&&status<300, status: status, json: function(){ return Promise.resolve(body); } }; }
function fakeFetch(url, opts){
  opts = opts||{}; var m = (opts.method||'GET').toUpperCase(); SERVER.calls.push(m);
  var q = {}; (url.split('?')[1]||'').split('&').forEach(function(p){ var i=p.indexOf('='); if(i>0) q[p.slice(0,i)]=decodeURIComponent(p.slice(i+1)); });
  var clone = function(o){ return JSON.parse(JSON.stringify(o)); };
  if(m==='GET'){ return Promise.resolve(resp(200, SERVER.row?[clone(SERVER.row)]:[])); }
  if(SERVER.beforeWrite){ var f=SERVER.beforeWrite; SERVER.beforeWrite=null; f(); }
  if(m==='PATCH'){
    if(SERVER.patchStatus!==200) return Promise.resolve(resp(SERVER.patchStatus, {message:'no'}));
    var b = JSON.parse(opts.body), cond = q.updated_at||'';
    var match = SERVER.row && (cond==='is.null' ? !SERVER.row.updated_at : cond==='eq.'+SERVER.row.updated_at);
    if(!match) return Promise.resolve(resp(200, []));
    SERVER.row.data=b.data; SERVER.row.updated_at=b.updated_at; return Promise.resolve(resp(200,[{id:'main'}]));
  }
  if(m==='POST'){ var arr=JSON.parse(opts.body); SERVER.row={id:'main',data:arr[0].data,updated_at:arr[0].updated_at}; return Promise.resolve(resp(201,null)); }
  return Promise.resolve(resp(400,null));
}
function cloudEdits(){ return JSON.parse(SERVER.row.data.precios_edits_v1||'{}'); }
function cloudKey(k){ return SERVER.row.data[k]; }

/* ---------- un "dispositivo" = una copia aislada de la app con su propio localStorage ---------- */
var CATALOG = [{cat:'PROTEIN'},
  {id:'ITM001',d:'1. CHICKEN THIGH BONELESS',f:'Semanal',lc:2.19,aa:null,lm:2.09,bm:null,unit:'lb'},
  {id:'ITM012',d:'2. SHRIMP 26/30 WHT P&D T-OFF',f:'Semanal',lc:5.85,aa:null,lm:5.65,bm:5.75,unit:'lb'},
  {cat:'PRODUCE'},
  {id:'ITM014',d:'3. AVOCADO X 60 CT RIPE',f:'Semanal',lc:57.5,aa:57.0,lm:57.35,bm:null},
  {id:'ITM015',d:'4. AVOCADO X 48 CT RIPE',f:'Semanal',lc:57.5,aa:54.0,lm:null,bm:null}];
var clock = Date.parse('2026-11-18T15:00:00.000Z');
var RealDate = Date;
function FakeDate(a){ if(arguments.length) return new RealDate(a); return new RealDate(clock); }
FakeDate.now = function(){ return clock; }; FakeDate.parse = RealDate.parse;
function tick(ms){ clock += (ms||1000); }

function makeDevice(name, devId, store){
  var ls = store || {};
  var timers = [];
  var env = {
    localStorage: { getItem:function(k){ return (k in ls)?ls[k]:null; }, setItem:function(k,v){ ls[k]=String(v); }, removeItem:function(k){ delete ls[k]; } },
    sessionStorage: { getItem:function(){return null;}, setItem:function(){}, removeItem:function(){} },
    document: { activeElement:null, getElementById:function(){return null;}, querySelector:function(){return null;}, createElement:function(){ return {style:{}}; }, body:{appendChild:function(){}} },
    location: { reloads:0, reload:function(){ this.reloads++; } },
    fetch: fakeFetch, Date: FakeDate,
    setTimeout: function(f){ timers.push(f); return timers.length; }, clearTimeout: function(){},
    stats: { builds:0 }
  };
  if(!store){ env.localStorage.setItem('precios_device_id', devId); env.localStorage.setItem('preciospro_cloud_cfg', JSON.stringify({url:'https://stub.invalid', key:'fake-test-key'})); }
  var body =
    'var BASE_CO_KEYS=["lc","aa","lm","bm"], EXTRA_CO=[], CUSTOM_KEY="precios_custom_v1", EDITS_KEY="precios_edits_v1", currentLang="es", itemIndex={};\n'+
    'var data=JSON.parse('+JSON.stringify(JSON.stringify(CATALOG))+');\n'+
    'function showToast(){} function _markPendingChanges(){} function rebuildIndexes(){} function renderDevices(){} function renderRecipes(){} function buildTable(){ stats.builds++; }\n'+
    APP + '\n' +
    'return { data:function(){return data;}, item:function(id){ return data.find(function(r){return r.id===id;}); },\n'+
    '  save:saveCustomProducts, push:cloudPush, pull:cloudPull, merge:cloudMergeData,\n'+
    '  startup: async function(){ loadCustomProducts(); normalizeCompanies(); normalizeProteinUnits(); _ssSnapshotMem(); await cloudPull(true); } };';
  var f = new Function('localStorage','sessionStorage','document','location','fetch','Date','setTimeout','clearTimeout','stats', body);
  var app = f(env.localStorage, env.sessionStorage, env.document, env.location, env.fetch, env.Date, env.setTimeout, env.clearTimeout, env.stats);
  app.name = name; app.ls = ls; app.env = env;
  app.runTimers = async function(){ var n=0; while(timers.length && n<20){ var t=timers.shift(); n++; await t(); } };
  app.reloads = function(){ return env.location.reloads; };
  return app;
}

/* ---------- mini framework ---------- */
var pass=0, fail=0, failures=[];
function ok(cond, msg){ if(cond){ pass++; print('  ok   - '+msg); } else { fail++; failures.push(msg); print('  FAIL - '+msg); } }
async function scenario(title, fn){ print('\n# '+title); SERVER.row=null; SERVER.calls=[]; SERVER.beforeWrite=null; SERVER.patchStatus=200; try{ await fn(); }catch(e){ fail++; failures.push(title+': '+e); print('  FAIL - excepción: '+e+'\n'+(e.stack||'')); } }

async function twoDevices(){
  var A = makeDevice('Mac','dMAC'), B = makeDevice('AGUIRRE','dAGU');
  await A.startup(); A.save(); await A.push(true);       /* A sube el catálogo inicial */
  tick(); await B.startup(); B.save(); await B.push(true); /* B lo baja */
  tick(); return [A,B];
}

(async function main(){
  await scenario('1. El bug de hoy: B (copia vieja) guarda Y y NO revierte X ni la unidad de ITM012', async function(){
    var d = await twoDevices(), A=d[0], B=d[1];
    A.item('ITM012').unit='caja'; A.item('ITM001').lc=2.50; A.save(); tick(); await A.push(true);
    ok(cloudEdits().ITM012.unit==='caja' && cloudEdits().ITM001.lc===2.5, 'A sube ITM012=caja e ITM001 lc=2.50');
    ok(cloudEdits().ITM012.updatedAt!=='' && cloudEdits().ITM012.by==='dMAC', 'A marca updatedAt y dispositivo en el producto editado');
    ok(cloudEdits().ITM015.updatedAt==='', 'productos NO editados no reciben fecha nueva');
    tick(5000);
    B.item('ITM014').aa=60; B.save(); tick(); await B.push(true);   /* B nunca bajó lo de A */
    var e = cloudEdits();
    ok(e.ITM012.unit==='caja', 'nube: ITM012 sigue en caja (no volvió a lb)');
    ok(e.ITM001.lc===2.5, 'nube: precio de ITM001 de A se conserva (X)');
    ok(e.ITM014.aa===60, 'nube: precio de ITM014 de B se guardó (Y)');
    ok(B.item('ITM012').unit==='caja' && B.item('ITM001').lc===2.5, 'B ve los cambios de A en pantalla sin recargar');
    ok(B.reloads()===0, 'B no recargó la página (desbloqueo de 15 min se mantiene)');
    B.save(); tick(); await B.push(true);
    ok(cloudEdits().ITM012.unit==='caja' && cloudEdits().ITM001.lc===2.5, 'un segundo guardado de B tampoco revierte nada');
    tick(); await A.pull(false);
    ok(A.item('ITM014').aa===60 && A.reloads()===0, 'A recibe el cambio de B sin recargar');
    var A2 = makeDevice('Mac-recargada', null, A.ls); await A2.startup();
    ok(A2.item('ITM012').unit==='caja', 'al recargar A, ITM012 sigue en caja (normalizeProteinUnits ya no lo pisa)');
  });

  await scenario('2. Datos viejos sin updatedAt y sin base (primer arranque tras publicar): gana la nube', async function(){
    var cloud={}; CATALOG.forEach(function(r){ if(r.id) cloud[r.id]={d:r.d,unit:r.unit||'',notes:'',inactive:false,locks:null,updatedAt:'',f:r.f,lc:r.lc,aa:r.aa,lm:r.lm,bm:r.bm}; });
    cloud.ITM012.unit='caja'; cloud.ITM001.lc=2.5;
    SERVER.row={id:'main',updated_at:'2026-11-18T14:00:00.000+00:00',data:{precios_edits_v1:JSON.stringify(cloud)}};
    var stale=JSON.parse(JSON.stringify(cloud)); stale.ITM012.unit='lb'; stale.ITM001.lc=2.19; delete stale.ITM012.by;
    var B = makeDevice('AGUIRRE','dAGU'); B.ls.precios_edits_v1=JSON.stringify(stale); B.ls._cloudSeenRemote='2026-11-18T13:00:00.000Z'; B.ls._cloudSig='x';
    await B.startup();
    ok(cloudEdits().ITM012.unit==='caja' && cloudEdits().ITM001.lc===2.5, 'la nube no se revierte con la copia vieja');
    ok(B.item('ITM012').unit==='caja' && B.item('ITM001').lc===2.5, 'B adopta los valores de la nube');
  });

  await scenario('3. Los dos editan el MISMO producto: gana el cambio más nuevo', async function(){
    var d = await twoDevices(), A=d[0], B=d[1];
    A.item('ITM014').lc=50; A.save(); tick(1000);
    B.item('ITM014').lc=51; B.save(); tick(1000);     /* B editó después */
    await A.push(true); tick(); await B.push(true);
    ok(cloudEdits().ITM014.lc===51, 'nube queda con el valor más nuevo (51 de B)');
    tick(); await A.pull(false);
    ok(A.item('ITM014').lc===51, 'A se actualiza al valor más nuevo');
  });

  await scenario('4. Otro dispositivo guarda justo entre la lectura y la escritura: se reintenta y no se pierde nada', async function(){
    var d = await twoDevices(), A=d[0], B=d[1];
    A.item('ITM001').lc=3.00; A.save(); tick();
    B.item('ITM015').aa=55; B.save(); tick();
    var pending=null;
    SERVER.beforeWrite=function(){ pending=A.push(true); };
    await B.push(true); await pending; tick(); await B.pull(false); await B.runTimers();
    var e=cloudEdits();
    ok(e.ITM001.lc===3 && e.ITM015.aa===55, 'ambos cambios quedan en la nube (ITM001=3.00, ITM015=55)');
    ok(SERVER.calls.filter(function(m){return m==='PATCH';}).length>=3, 'hubo choque: el PATCH condicional de B falló y se reintentó (>=3 PATCH)');
  });

  await scenario('5. Productos nuevos, historial de precios y borrados', async function(){
    var d = await twoDevices(), A=d[0], B=d[1];
    A.data().push({id:'CUSTOM_A1',d:'5. NUEVO DE A',f:'Semanal',lc:1,aa:null,lm:null,bm:null,unit:'cs'}); A.save();
    var phA={ITM001:[{date:'2026-11-18T15:00:01.000Z',lc:2.5}]}; A.ls.precios_price_history_v1=JSON.stringify(phA);
    tick(); await A.push(true); tick();
    B.data().push({id:'CUSTOM_B1',d:'6. NUEVO DE B',f:'Semanal',lc:2,aa:null,lm:null,bm:null,unit:'cs'}); B.save();
    B.ls.precios_price_history_v1=JSON.stringify({ITM014:[{date:'2026-11-18T15:00:05.000Z',aa:60}]});
    tick(); await B.push(true);
    var cu=JSON.parse(cloudKey('precios_custom_v1')).map(function(x){return x.id;});
    ok(cu.indexOf('CUSTOM_A1')>=0 && cu.indexOf('CUSTOM_B1')>=0, 'los dos productos nuevos quedan en la nube');
    var ph=JSON.parse(cloudKey('precios_price_history_v1'));
    ok(ph.ITM001 && ph.ITM014, 'historial de precios de ambos dispositivos se conserva');
    ok(B.item('CUSTOM_A1') && B.item('CUSTOM_A1').d==='5. NUEVO DE A', 'B ve el producto nuevo de A sin recargar');
    /* A borra CUSTOM_B1 (como deleteProductForever) */
    tick(); await A.pull(false);
    var i=A.data().findIndex(function(r){return r.id==='CUSTOM_B1';}); A.data().splice(i,1);
    A.ls.precios_deleted_v1=JSON.stringify(['CUSTOM_B1']); A.save(); tick(); await A.push(true);
    tick(); B.item('ITM015').lc=60; B.save(); tick(); await B.push(true);
    var cu2=JSON.parse(cloudKey('precios_custom_v1')).map(function(x){return x.id;});
    ok(cu2.indexOf('CUSTOM_B1')<0 && !cloudEdits().CUSTOM_B1, 'un producto borrado a propósito no "revive"');
    ok(!B.item('CUSTOM_B1'), 'B también lo quita de pantalla');
  });

  await scenario('6. Otras llaves (compañías): la copia vieja no pisa la nube', async function(){
    var d = await twoDevices(), A=d[0], B=d[1];
    A.ls.precios_companies_v1=JSON.stringify([{key:'xms205mdo',name:'Nueva'}]); tick(); await A.push(true); tick();
    B.item('ITM014').bm=40; B.save(); tick(); await B.push(true);
    ok(cloudKey('precios_companies_v1')===A.ls.precios_companies_v1, 'compañías de A se conservan aunque B guarde');
    ok(B.ls.precios_companies_v1===A.ls.precios_companies_v1, 'B adopta las compañías nuevas');
    ok(B.reloads()===1, 'B recarga solo porque cambiaron compañías (necesitan recarga), sin perder el desbloqueo (sessionStorage)');
  });

  await scenario('7. Si Supabase no acepta PATCH, cae a upsert pero igual mezclado', async function(){
    var d = await twoDevices(), A=d[0], B=d[1];
    A.item('ITM012').unit='caja'; A.save(); tick(); await A.push(true); tick();
    SERVER.patchStatus=405;
    B.item('ITM014').aa=61; B.save(); tick(); await B.push(true);
    ok(cloudEdits().ITM012.unit==='caja' && cloudEdits().ITM014.aa===61, 'ambos cambios quedan aunque PATCH falle');
  });

  print('\nRESULTADO: '+pass+' ok, '+fail+' fallas');
  if(fail){ print('Fallas: '+failures.join(' | ')); throw new Error('TESTS FALLARON'); }
})().catch(function(e){ print('ERROR: '+e); throw e; });
