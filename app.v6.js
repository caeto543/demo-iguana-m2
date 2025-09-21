/* Demo V6 — Pastoreo PV6 */
console.log('Demo V6 — Pastoreo PV6');

/* ===== Archivos esperados ===== */
const FILES = {
  GEO: 'potreros.geojson',
  PADRES: 'DEMO_biomasa_2025_PADRES_UI.csv',
  HIJOS:  'DEMO_biomasa_2025_HIJOS_UI.csv',
  MOV:    'MOV_GANADO_CARGA_MIX.csv', // NUEVO en V6
  PET0:   'Iguana_P_minus_ET0_diario_2025_FULL.csv',
  AREAS:  'Nombres_area_iguana.csv',
  FND:    'Iguana_FND_por_potrero.csv',
  DEFAULTS: 'PV6_defaults.json'
};

/* ===== Estado ===== */
const state = {
  start: "2025-01-01", end:null,
  overlay:'biomasa', scope:'__ALL__',
  fuente:'smoothed',      // 'smoothed' o 'raw'
  mode: 'eq',         // 'eq' | 'gain' | 'etico'
  coefUso:60, consumo:10,                // consumo base (kg/UA/d), se ajusta por FDN
  params: {"Emin": 2600, "Emax": 3200, "Smin": 1600, "Smax": 1900, "alpha": 0.6, "beta": 0.05, "wmax": 0.3, "dslmin": 28, "dslmax": 60},
  qcMaxAge: 6,
  auKg: 450,                   // kg PV por 1 UA (default 450)
  weights: {"eq": {"entrada": 35, "calidad": 25, "pendiente": 20, "descanso": 15, "qc": 5}, "gain": {"entrada": 40, "calidad": 30, "pendiente": 20, "descanso": 8, "qc": 2}, "etico": {"entrada": 30, "calidad": 20, "pendiente": 15, "descanso": 30, "qc": 5}}
};
/* ===== Persistencia (params) ===== */
const urlParams = new URLSearchParams(location.search);
const FARM_ID = urlParams.get('farm') || 'default';
const LS_KEY = `pv6:user:${FARM_ID}`;

function loadUserConfig(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch(e){ console.warn('User config load error', e); return null; }
}

function saveUserConfig(cfg){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  }catch(e){ console.warn('User config save error', e); }
}


const nf0 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

const parseDate = s => new Date(s + 'T00:00:00');
const toISO = d => new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
const addDays = (d,n)=>{ const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const daysBetween = (a,b)=>Math.floor((b-a)/86400000);
const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
const fmtK = n => nf0.format(Math.round(n));
const fmt1 = n => nf1.format(n);

/* ===== helpers canon ===== */
function canonBase(s){ return String(s||'').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/_+/g,'_'); }
function canonPlus(s){
  let x=canonBase(s);
  x=x.replace(/(\d+)([a-z])/g,'$1_$2');
  x=x.split('_').map(t=>/^-?\d+$/.test(t)?String(parseInt(t,10)):t).join('_');
  return x;
}
const isZ = nm => /^z/.test(String(nm||'').toLowerCase());

/* ===== lookups ===== */
function lastOnOrBefore(arr, d, key){
  if (!arr || !arr.length) return null;
  for (let i=arr.length-1; i>=0; i--){
    const di = parseDate(arr[i].date);
    const v = arr[i][key];
    if (di <= d && v != null && !Number.isNaN(v)) return v;
  }
  return null;
}

function occFromRow(r){
  if (!r) return false;
  const occExplicit = r.ocupado != null ? Number(r.ocupado)>0 : null;
  const occByLoad   = (Number(r.UA_total||0)>0) || (Number(r.PV_total_kg||0)>0) || (Number(r.N_total||0)>0);
  return occExplicit!=null ? occExplicit : occByLoad;
}

function getLastMoveRow(arrM, d){
  if (!arrM || !arrM.length) return null;
  let row=null;
  for (let i=arrM.length-1; i>=0; i--){
    const di=parseDate(arrM[i].date);
    if (di<=d){ row=arrM[i]; break; }
  }
  if (!row) row = arrM[0];
  return row||null;
}

function inferUAandOcc(arrM, d, auKg){
  const row = getLastMoveRow(arrM, d);
  if (!row) return {UA:0, occ:false, row:null};
  const occ = occFromRow(row);
  // UA prioridad: UA_total -> PV_total_kg/auKg -> N_total (asume 1 cab ~ 1 UA)
  let UA = Number(row.UA_total||0);
  if (!UA) UA = (Number(row.PV_total_kg||0) && auKg>0) ? Number(row.PV_total_kg)/auKg : 0;
  if (!UA) UA = Number(row.N_total||0) || 0;
  return {UA, occ, row};
}

function computeRestDaysFromEvents(arrM, d){
  if (!arrM || !arrM.length) return null;
  const rows=[...arrM].sort((a,b)=>a.date.localeCompare(b.date));
  let prevOcc = occFromRow(rows[0]);
  let lastFreeStart = prevOcc ? null : parseDate(rows[0].date);
  for (let i=1;i<rows.length;i++){
    const di=parseDate(rows[i].date);
    if (di>d) break;
    const curOcc = occFromRow(rows[i]);
    if (!curOcc && prevOcc) lastFreeStart = di;
    if (curOcc && !prevOcc) lastFreeStart = null;
    prevOcc = curOcc;
  }
  if (prevOcc) return 0;
  if (lastFreeStart==null) return null;
  return Math.max(0, daysBetween(lastFreeStart, d)+1);
}

/* ===== geo helpers ===== */
function getCanonName(props){
  const cand=['name_canon','Name_Propuesto','Name','name','NAME','nameCanon','name_final','Potrero'];
  for (const k of cand){ if (props && props[k] != null && String(props[k]).trim()!=='') return canonPlus(props[k]); }
  return null;
}
function getAreaHaFromGeo(props){
  const cand=['geom_area_ha','Area_ha','area_ha','Area_Ha','area_ha_ref','AREA_HA','ha','hectareas'];
  for (const k of cand){ const v=Number(props?.[k]); if (Number.isFinite(v)&&v>0) return v; }
  const m2=Number(props?.geom_area_m2||props?.clean_area_m2||props?.area_m2||props?.Area_m2);
  if (Number.isFinite(m2)&&m2>0) return m2/10000;
  return 0;
}
function abbrev(n){
  const s=String(n||'').toLowerCase();
  if (s.startsWith('guasimal_z_')) return 'Gz';
  if (s.startsWith('guasimal_'))   return 'G'+s.split('_')[1];
  if (s.startsWith('la_divisa_'))  return 'D'+(s.split('_')[2]??s.split('_')[1]);
  if (s.startsWith('pasto_viejo_')) return 'PV'+s.split('_')[2];
  if (s.startsWith('pecho_de_paloma_')) return 'PP'+s.split('_')[3];
  if (s === 'enfermeria') return 'ENF';
  return s.replaceAll('_','').toUpperCase();
}

/* ===== colores ===== */
const greens=['#e8f5e9','#c8e6c9','#a5d6a7','#66bb6a','#2e7d32'];
function biomasaColor(v, breaks){
  if (v==null) return '#dcdcdc';
  if (!breaks || breaks.length<4){
    if (v<1500) return greens[0];
    if (v<2000) return greens[1];
    if (v<2500) return greens[2];
    if (v<3000) return greens[3];
    return greens[4];
  }
  if (v<=breaks[0]) return greens[0];
  if (v<=breaks[1]) return greens[1];
  if (v<=breaks[2]) return greens[2];
  if (v<=breaks[3]) return greens[3];
  return greens[4];
}
function pet0Color(v,min,max){
  if (v==null) return '#eee';
  const mid=0, c2=(x,a,b)=>Math.max(a,Math.min(b,x));
  const t = v>=mid ? c2((v-mid)/(max-mid||1),0,1) : c2((v-min)/(mid-min||1),0,1);
  const c = Math.round(200 - t*140);
  return `rgb(${c},${c+20},255)`;
}

/* ===== stores ===== */
let map, geoLayer, dslLayer;
let chartSmall, chartBig;
const AREAS=new Map(), PARENTS=new Set(), ALL_NAMES=new Set();
const series=new Map(), moves=new Map(), pet0=new Map(), FND=new Map();
let AREA_TOTAL_CSV=0, LAST_DATE=null;

/* ===== CSV loader ===== */
async function fetchTextSafe(path){ const r=await fetch(path); if(!r.ok) throw new Error('HTTP '+r.status+' '+path); return await r.text(); }
async function loadCSVSmart(path){
  let text; try{ text=await fetchTextSafe(path); }catch(e){ console.warn('No se pudo cargar', path, e?.message||e); return []; }
  let res=Papa.parse(text,{header:true,dynamicTyping:true,skipEmptyLines:true});
  let data=(res?.data||[]).filter(r=>Object.keys(r).length>0);
  if (data.length<=1){ res=Papa.parse(text,{header:true,dynamicTyping:true,skipEmptyLines:true,delimiter:';'}); data=(res?.data||[]).filter(r=>Object.keys(r).length>0); }
  data = data.map(r=>{ const out={}; for(const k of Object.keys(r)){ out[String(k).trim().replace(/\s+/g,'_')] = r[k]; } return normalizeRow(out); });
  return data;
}
function numOrNull(v){
  if (v==null || v==='') return null;
  if (typeof v==='number') return Number.isFinite(v)?v:null;
  const raw=String(v).trim(); if (raw==='') return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) return parseFloat(raw.replace(/\./g,'').replace(',','.'));
  if (/^-?\d+,\d+$/.test(raw)) return parseFloat(raw.replace(',','.'));
  const cleaned=raw.replace(/\s+/g,''); const n=Number(cleaned); return Number.isFinite(n)?n:null;
}
function normalizeRow(r){
  r.name_canon = canonPlus(r.name_canon ?? r.Name ?? r.NAME ?? r.name ?? r.Name_Propuesto ?? r.Potrero ?? r.parent ?? r.padre ?? null);
  r.date = r.date ?? r.Fecha ?? r.fecha ?? r.Dia ?? r.dia ?? null;
  if (r.date && /^\d{2}\/\d{2}\/\d{4}$/.test(r.date)){ const [dd,mm,yy]=r.date.split('/'); r.date=`${yy}-${mm}-${dd}`; }
  if (r.date) r.date = String(r.date).substring(0,10);
  r.kgms_raw = numOrNull(r.kgms_raw ?? r.biomasa_pred ?? r.kgms ?? r.kg_ms_ha ?? r.KgMS_ha ?? r.biomasa);
  r.kgms_7d  = numOrNull(r.kgms_7d ?? r.kgms_sigmoid_L7 ?? r.biomasa_pred_7d ?? r.kgms_smooth7);
  r.N_total  = numOrNull(r.N_total ?? r.N ?? r.cabezas);
  r.UA_total = numOrNull(r.UA_total ?? r.UA);
  r.PV_total_kg = numOrNull(r.PV_total_kg ?? r.peso_vivo_total_kg ?? r.PV_kg ?? r.Peso_vivo_total);
  r.DSL = numOrNull(r.DSL ?? r.rest_days ?? r.descanso);
  r.ocupado = numOrNull(r.ocupado ?? r.occupied);
  r.P_minus_ET0_1d_mm_7d = numOrNull(r.P_minus_ET0_1d_mm_7d ?? r.mm_7d ?? r.P_menos_ET0_7d);
  r.area_ha = numOrNull(r.area_ha ?? r.Area ?? r.Area_ha ?? r.geom_area_ha ?? r.ha);
  r.FND = numOrNull(r.FND ?? r.fnd ?? r.NDF);
  return r;
}

/* ===== init ===== */
(async function init(){ try{

  // 0) Defaults (opcional): si existe JSON, sobre-escribe estado
  try{
    const p = await fetch(FILES.DEFAULTS).then(r=>r.ok?r.json():null);
    if (p) {
      state.start = p?.date_range?.start ?? state.start;
      state.fuente = p?.fuente_default ?? state.fuente;
      state.mode   = p?.mode_default ?? state.mode;
      if (p?.params) Object.assign(state.params, p.params);
      state.qcMaxAge = p?.qcMaxAge ?? state.qcMaxAge;
      state.auKg = p?.auKg ?? state.auKg;
      if (p?.ranking_weights) state.weights = p.ranking_weights;
    }
  }catch(e){ console.warn('PV6_defaults no disponible', e); }

  // Aplicar persistencia de usuario (si existe)
  const ucfg = loadUserConfig();
  if (ucfg){
    // comunes
    if (ucfg.global){
      if (ucfg.global.params) Object.assign(state.params, ucfg.global.params);
      if (ucfg.global.qcMaxAge!=null) state.qcMaxAge = ucfg.global.qcMaxAge;
      if (ucfg.global.auKg!=null) state.auKg = ucfg.global.auKg;
      if (ucfg.global.coefUso!=null) state.coefUso = ucfg.global.coefUso;
      if (ucfg.global.consumo!=null) state.consumo = ucfg.global.consumo;
    }
    // por modo (pegajoso)
    if (ucfg.sticky && ucfg.per_mode && ucfg.per_mode[state.mode]){
      const set = ucfg.per_mode[state.mode];
      if (set.params) Object.assign(state.params, set.params);
    }
    // preferencias UI
    if (ucfg.last_mode) state.mode = ucfg.last_mode;
    if (ucfg.last_fuente) state.fuente = ucfg.last_fuente;
    if (ucfg.last_overlay) state.overlay = ucfg.last_overlay;
  }

  // 1) GEO + bounds
  const gj = await fetch(FILES.GEO).then(r=>r.json());
  gj.features.forEach(f=>{
    const nm=getCanonName(f.properties);
    const areaG=getAreaHaFromGeo(f.properties);
    if (!nm) return;
    ALL_NAMES.add(nm);
    const isParent = (f.properties?.is_parent===true) || (!nm.includes('_z_'));
    if (isParent) PARENTS.add(nm);
    if (!AREAS.has(nm)) AREAS.set(nm, areaG);
    f.properties.__canon=nm; f.properties.__area_geo=areaG;
  });
  const bounds = L.geoJSON(gj).getBounds();

  // 2) ÁREAS CSV
  const areasRows = await loadCSVSmart(FILES.AREAS);
  AREA_TOTAL_CSV=0;
  areasRows.forEach(r=>{
    if (r.name_canon && r.area_ha!=null && r.area_ha>0){
      AREAS.set(r.name_canon, r.area_ha);
      AREA_TOTAL_CSV += r.area_ha;
      ALL_NAMES.add(r.name_canon);
      if (!r.name_canon.includes('_z_')) PARENTS.add(r.name_canon);
    }
  });

  // 3) BIOMASA
  const [rowsP, rowsH] = await Promise.all([ loadCSVSmart(FILES.PADRES), loadCSVSmart(FILES.HIJOS) ]);
  const pushRow=r=>{ if(!r.name_canon||!r.date)return;
    const nm=r.name_canon; if(!series.has(nm)) series.set(nm,[]);
    series.get(nm).push({date:r.date, kgms_raw:r.kgms_raw, kgms_7d:(r.kgms_7d!=null?r.kgms_7d:r.kgms_raw)});
  };
  rowsP.forEach(pushRow); rowsH.forEach(pushRow);
  for (const [k,arr] of series) arr.sort((a,b)=>a.date.localeCompare(b.date));
  LAST_DATE = [...series.values()].reduce((acc,arr)=>{
    if(!arr.length) return acc; const d=parseDate(arr[arr.length-1].date);
    return (!acc||d>acc)? d : acc;
  }, null);
  state.end = toISO(LAST_DATE || parseDate(state.start));

  // 4) MOVIMIENTOS (V6: UA / PV_total / N_total)
  const rowsM = await loadCSVSmart(FILES.MOV);
  rowsM.forEach(r=>{
    if(!r.name_canon||!r.date) return;
    const nm=r.name_canon; if(!moves.has(nm)) moves.set(nm,[]);
    moves.get(nm).push({
      date:r.date,
      N_total:r.N_total??0,
      UA_total:r.UA_total??0,
      PV_total_kg:r.PV_total_kg??0,
      DSL:r.DSL,
      ocupado:r.ocupado
    });
  });
  for (const [k,arr] of moves) arr.sort((a,b)=>a.date.localeCompare(b.date));

  
// Auto-extender fecha 'end' con la última fecha de movimientos
(function(){ try {
  let lastMoveDate = null;
  for (const [k, arr] of moves) {
    if (arr.length) {
      const d = new Date(arr[arr.length-1].date + 'T00:00:00');
      if (!lastMoveDate || d > lastMoveDate) lastMoveDate = d;
    }
  }
  if (lastMoveDate) {
    const endCur = new Date(state.end + 'T00:00:00');
    if (!endCur || lastMoveDate > endCur) {
      state.end = (new Date(lastMoveDate.getTime()-lastMoveDate.getTimezoneOffset()*60000)).toISOString().slice(0,10);
      const el = document.getElementById('date-end'); if (el) el.value = state.end;
    }
  }
} catch(e) { console.warn('No se pudo auto-extender end con movimientos', e); } })();
// 5) P–ET0
  const petRows = await loadCSVSmart(FILES.PET0);
  petRows.forEach(r=>{
    if(!r.name_canon||!r.date) return;
    const nm=r.name_canon; if(!pet0.has(nm)) pet0.set(nm,[]);
    if(r.P_minus_ET0_1d_mm_7d!=null) pet0.get(nm).push({date:r.date, mm7d:r.P_minus_ET0_1d_mm_7d});
  });
  for (const [k,arr] of pet0) arr.sort((a,b)=>a.date.localeCompare(b.date));

  // 6) FND opcional
  const fndRows = await loadCSVSmart(FILES.FND);
  fndRows.forEach(r=>{
    if(!r.name_canon||r.FND==null) return;
    let v=Number(r.FND); if(v>1.01) v=v/100; v=clamp(v,0,1); FND.set(r.name_canon,v);
  });

  // 7) UI defaults
  const setVal=(id,val)=>{ const el=document.getElementById(id); if (el) el.value=val; };
  setVal('date-start', state.start);
  setVal('overlay', state.overlay);
  setVal('fuente', state.fuente);
  setVal('mode', state.mode);
  setVal('date-end', state.end);
  setVal('coef-uso', String(state.coefUso));
  setVal('consumo', String(state.consumo));

  const sel=document.getElementById('pot-select');
  if (sel){
    const namesSorted=Array.from(ALL_NAMES).sort((a,b)=>a.localeCompare(b,'es'));
    for(const nm of namesSorted){ const opt=document.createElement('option'); opt.value=nm; opt.textContent=nm; sel.appendChild(opt); }
  }

  // 8) MAPA
  if (map && typeof map.remove==='function'){ map.off(); map.remove(); }
  map = L.map('map', {
      scrollWheelZoom:false,
      dragging:false,
      worldCopyJump:false,
      doubleClickZoom:false,
      boxZoom:false,
      keyboard:false,
      zoomControl:false,
      maxBounds: bounds,
      maxBoundsViscosity: 1.0
    });
  map.fitBounds(bounds);
  (function(){ try { const z = map.getZoom(); map.setMinZoom(z); map.setMaxZoom(z); } catch(e){} })();
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap', noWrap:true }).addTo(map);
  dslLayer=L.layerGroup().addTo(map);
  geoLayer=L.geoJSON(gj,{ style: feat=>({color:'#333',weight:1,fillColor:'#ddd',fillOpacity:.9}),
    onEachFeature:(feat,layer)=>{
      const nm=feat.properties.__canon; if(!nm) return;
      if (PARENTS.has(nm)){
        const center=layer.getBounds().getCenter();
        const tip=L.tooltip({permanent:true,direction:'center',className:'map-label',opacity:0.9}).setContent(abbrev(nm)).setLatLng(center);
        tip.addTo(map);
      }
      layer.on('click', ()=>{ state.scope=nm; if(sel) sel.value=nm; renderAll(); });
    }
  }).addTo(map);

  // 9) Listeners
  document.getElementById('overlay').addEventListener('change', e=>{ state.overlay=e.target.value; renderMap(); 
    (function(){
      const cfg = loadUserConfig() || { sticky:false, per_mode:{}, global:{ qcMaxAge: state.qcMaxAge, auKg: state.auKg, coefUso: state.coefUso, consumo: state.consumo } };
      cfg.last_mode = state.mode;
      cfg.last_fuente = state.fuente;
      cfg.last_overlay = state.overlay;
      saveUserConfig(cfg);
    })();
});
  document.getElementById('fuente').addEventListener('change', e=>{ state.fuente=e.target.value; renderAll(); 
    (function(){
      const cfg = loadUserConfig() || { sticky:false, per_mode:{}, global:{ qcMaxAge: state.qcMaxAge, auKg: state.auKg, coefUso: state.coefUso, consumo: state.consumo } };
      cfg.last_mode = state.mode;
      cfg.last_fuente = state.fuente;
      cfg.last_overlay = state.overlay;
      saveUserConfig(cfg);
    })();
});
  document.getElementById('mode').addEventListener('change', e=>{ state.mode=e.target.value; applyModeDefaultParams(); renderAll(); 
    (function(){
      const cfg = loadUserConfig() || { sticky:false, per_mode:{}, global:{ qcMaxAge: state.qcMaxAge, auKg: state.auKg, coefUso: state.coefUso, consumo: state.consumo } };
      cfg.last_mode = state.mode;
      cfg.last_fuente = state.fuente;
      cfg.last_overlay = state.overlay;
      saveUserConfig(cfg);
    })();
});
  sel.addEventListener('change', e=>{ state.scope=e.target.value; renderAll(); });
  document.getElementById('date-start').addEventListener('change', e=>{ state.start=e.target.value; renderAll(); });
  document.getElementById('date-end').addEventListener('change', e=>{ state.end=e.target.value; renderAll(); });
  document.getElementById('btn-apply').addEventListener('click', ()=>{ 
    const g=id=>Number(document.getElementById(id)?.value)||0;
    state.coefUso=g('coef-uso'); state.consumo=g('consumo');
    renderAll();
  
    (function(){
      const cfg = loadUserConfig() || { sticky:false, per_mode:{}, global:{} };
      cfg.global = Object.assign({}, cfg.global, { qcMaxAge: state.qcMaxAge, auKg: state.auKg, coefUso: state.coefUso, consumo: state.consumo });
      cfg.last_mode = state.mode; cfg.last_fuente = state.fuente; cfg.last_overlay = state.overlay;
      saveUserConfig(cfg);
    })();
});
  document.getElementById('btn-params').addEventListener('click', openParamsModal);
  document.getElementById('expand-chart').addEventListener('click', openChartModal);

  renderAll();

  /* ====== BRIDGE PARA ADDONS (M2.2) ======
     PÉGALO INMEDIATAMENTE DESPUÉS DE: renderAll();  */
  try {
    // Espacio global PV6
    window.PV6 = window.PV6 || {};
    PV6.state = state;

    // ---- Datos que el addon necesita ----
    PV6.data = PV6.data || {};
    PV6.data.geojson = gj;

    // Mapa: potrero -> { fechaISO: kgms_7d }
    (function buildKg7(){
      const out = Object.create(null);
      for (const [nm, arr] of series) {
        const byDate = Object.create(null);
        for (const r of arr) {
          if (!r || !r.date) continue;
          byDate[r.date] = (r.kgms_7d != null ? r.kgms_7d : (r.kgms_raw ?? null));
        }
        out[nm] = byDate;
      }
      PV6.data.kgms7dByPot = out;
    })();

    // *** NUEVO: mapa RAW potrero -> { fechaISO: kgms_raw } + aliases ***
    (function buildKgRaw(){
      const out = Object.create(null);
      for (const [nm, arr] of series) {
        const byDate = Object.create(null);
        for (const r of arr) {
          if (!r || !r.date) continue;
          byDate[r.date] = (r.kgms_raw != null ? r.kgms_raw : (r.kgms_7d ?? null));
        }
        out[nm] = byDate;
      }
      PV6.data.kgmsRawByPot = out;      // nombre principal
      PV6.data.kgms_by_pot  = out;      // alias común
      PV6.data.kg_by_pot    = out;      // alias adicional
    })();

    // Áreas (objeto plano)
    PV6.data.areaHaByPot = Object.fromEntries(AREAS);

    // Movimientos en filas limpias
    PV6.data.movRows = (function(){ 
      const rows = [];
      for (const [nm, arr] of moves) {
        for (const r of arr) rows.push({ name_canon:nm, date:r.date, UA_total:r.UA_total, PV_total_kg:r.PV_total_kg, N_total:r.N_total, DSL:r.DSL, ocupado:r.ocupado });
      }
      return rows.sort((a,b)=> a.date.localeCompare(b.date));
    })();

    // ---- API mínima de UI que usa el addon ----
    PV6.ui = PV6.ui || {};
    PV6.ui.refreshMap = renderMap;
    PV6.ui.refreshRanking = function(/* uaOverride opcional */){ renderRanking(); renderPastoreoChips(); };
    PV6.ui.onKpiChange = function(/* { uaTot } */){}; // opcional

    // *** NUEVO: helpers de Kg EXACTOS (mismo dato del mapa/cabecera) ***
    PV6.kgForPot = function(nm, dateISO, fuenteMode){
      const d=parseDate(dateISO); const arr=series.get(nm)||[];
      const useRaw = (String(fuenteMode||'').toLowerCase().includes('raw'));
      let v = useRaw ? lastOnOrBefore(arr,d,'kgms_raw') : lastOnOrBefore(arr,d,'kgms_7d');
      if (v==null) v = lastOnOrBefore(arr,d,'kgms_7d');
      return v;
    };
    PV6.getKgForPot = PV6.kgForPot;
    PV6.ui.kgForPot = (nm, dateISO, fuenteMode)=> PV6.kgForPot(nm, dateISO, fuenteMode);

    PV6.ui.getSuggestedDests = function(dateISO){
      const rs = computeRanking(dateISO);
      return rs.slice(0, 8).map(r => r.nm);
    };

    // Cálculo de días con override de UA
    PV6.computeDays = function(pot, dateISO, uaOverride){
      const dEnd = parseDate(dateISO);
      const area = AREAS.get(pot) || 0;
      const arr  = series.get(pot) || [];
      let kg = (state.fuente==='raw') ? lastOnOrBefore(arr,dEnd,'kgms_raw') : lastOnOrBefore(arr,dEnd,'kgms_7d');
      if (kg==null) kg = lastOnOrBefore(arr,dEnd,'kgms_7d');
      const fnd = FND.has(pot) ? FND.get(pot) : null;
      const { D0, Dadj } = computeDays(kg, area, (uaOverride||0), fnd);
      return { d0: D0||0, dadj: Dadj||0 };
    };

    // Hook: datos listos → arrancar M2.2
    PV6.onDataReady = function(){
      if (typeof window.__PV6_M2_INIT__ === "function") window.__PV6_M2_INIT__();
    };
    PV6.onDataReady();

  } catch(e) {
    console.warn("[M2.2] bridge init warning:", e);
  }
  /* ====== FIN BRIDGE M2.2 ====== */

}catch(err){ console.error('Error en init V6', err); }})();

/* ===== selección / breaks ===== */
function selectedParents(){ return Array.from(PARENTS.size ? PARENTS : Array.from(ALL_NAMES).filter(n=>!n.includes('_z_'))); }
function computeBreaksBiomasa(dEnd){
  const vals=[];
  for(const nm of selectedParents()){
    const arr=series.get(nm)||[];
    const v=lastOnOrBefore(arr,dEnd,'kgms_7d');
    if(v!=null) vals.push(v);
  }
  vals.sort((a,b)=>a-b);
  if (vals.length<5) return null;
  const q=p=>vals[Math.floor((vals.length-1)*p)];
  return [q(0.2),q(0.4),q(0.6),q(0.8)];
}

/* ===== Pastoreo core ===== */
function kgFor(nm, ds){
  const arr=series.get(nm)||[]; const d=parseDate(ds);
  let v=(state.fuente==='raw')? lastOnOrBefore(arr,d,'kgms_raw') : lastOnOrBefore(arr,d,'kgms_7d');
  if (v==null) v=lastOnOrBefore(arr,d,'kgms_7d');
  return v;
}
function lastKgDate(nm, ds){
  const arr=series.get(nm)||[]; const d=parseDate(ds);
  for (let i=arr.length-1;i>=0;i--){
    const di=parseDate(arr[i].date); const v=arr[i].kgms_7d ?? arr[i].kgms_raw; if (di<=d && v!=null) return di;
  }
  return null;
}
function slope7d(nm, ds){
  const arr=series.get(nm)||[]; if(!arr.length) return null;
  const dEnd=parseDate(ds), dIni=addDays(dEnd,-7);
  const v2=lastOnOrBefore(arr,dEnd,'kgms_7d'), v1=lastOnOrBefore(arr,dIni,'kgms_7d');
  if (v1==null || v2==null) return null;
  return (v2 - v1)/7;
}
function entryOK(kg,dsl){ const p=state.params; const inRange=(kg!=null)&&(kg>=p.Emin)&&(kg<=p.Emax); const restOK=(dsl==null)?false:(dsl>=p.dslmin); return inRange&&restOK; }
function computeDays(kg, area, UA, fnd){
  const uso=(state.coefUso/100); const base=state.consumo;
  const cons=(fnd==null)? base : clamp(base*(1 - state.params.alpha*fnd), 7, 14);
  const oferta=(kg||0)*area*uso; const demanda=UA*cons;
  if (demanda<=0) return {D0:null, Dadj:null, cons};
  const D0=oferta/demanda; const phi=1 - Math.min(state.params.beta*Math.max(D0-1,0), state.params.wmax);
  const Dadj=D0*phi; return {D0, Dadj, cons};
}
function statusFromScore(score, ok){ if(!ok||score<50) return -1; if(score<70) return 0; return 1; }
function applyModeDefaultParams(){
  const p=state.params;
  if(state.mode==='eq')   Object.assign(p, {"Emin": 2600, "Emax": 3200, "Smin": 1600, "Smax": 1900, "alpha": 0.6, "beta": 0.05, "wmax": 0.3, "dslmin": 28, "dslmax": 60});
  if(state.mode==='gain') Object.assign(p, {Emin:2800,Emax:3400,Smin:1700,Smax:2000,alpha:0.75,beta:0.06,wmax:0.30,dslmin:25,dslmax:55});
  if(state.mode==='etico')Object.assign(p, {Emin:2600,Emax:3100,Smin:1600,Smax:1850,alpha:0.5,beta:0.04,wmax:0.25,dslmin:30,dslmax:70});
}

// Normaliza pendiente por rango del día
function normalizedSlopeScore(nm, ds){
  const slopes=[];
  for (const p of selectedParents()){
    const s = slope7d(p, ds);
    if (s!=null && Number.isFinite(s)) slopes.push(s);
  }
  if (!slopes.length) return 50;
  const minS=Math.min(...slopes), maxS=Math.max(...slopes);
  const s = slope7d(nm, ds) ?? 0;
  if (Math.abs(maxS - minS) < 1e-6) return 50;
  return clamp(100 * (s - minS) / (maxS - minS), 0, 100);
}

function computeRanking(ds){
  const rows=[], dEnd=parseDate(ds);
  for(const nm of selectedParents()){
    const area=AREAS.get(nm)||0;
    const m=moves.get(nm)||[];
    const {UA, occ}=inferUAandOcc(m,dEnd,state.auKg);
    const dsl=computeRestDaysFromEvents(m,dEnd);
    const fnd=FND.has(nm)? FND.get(nm) : null;
    const kg=kgFor(nm,ds);
    if (kg==null || !Number.isFinite(kg)) continue;

    const sNorm = normalizedSlopeScore(nm, ds);
    const sRaw  = slope7d(nm, ds) ?? 0;
    const UA_for_days = occ ? UA : 0;
    const {D0, Dadj}=computeDays(kg, area, UA_for_days, fnd);

    const p=state.params;
    const cEntrada = (kg<p.Emin)? (100*(kg/p.Emin)) : (kg>p.Emax)? (100*(p.Emax/Math.max(kg,p.Emax))) : 100;
    const penalSobremadurez=(kg>3500)? Math.min(30,(kg-3500)/10) : 0;
    const cCalidad=Math.max(0, 100 - (fnd==null?0:fnd*100*state.params.alpha) - penalSobremadurez);
    const cPend=sNorm;
    const cDesc=(dsl==null)? 0 : clamp(100*Math.min(1, dsl/Math.max(1,p.dslmin)), 0, 100);

    // QC antigüedad
    let cQC=100;
    const dLast=lastKgDate(nm,ds);
    if (dLast){
      const age=daysBetween(dLast,dEnd);
      if (age>state.qcMaxAge){
        const extra=age - state.qcMaxAge;
        cQC = clamp(100 - extra*8, 55, 100);
      }
    }

    const w = state.weights?.[state.mode] ?? {entrada:35,calidad:25,pendiente:20,descanso:15,qc:5};

    const score = (cEntrada*w.entrada + cCalidad*w.calidad + cPend*w.pendiente + cDesc*w.descanso + cQC*w.qc) / (w.entrada+w.calidad+w.pendiente+w.descanso+w.qc);
    const ok = entryOK(kg,dsl); const estado=statusFromScore(score, ok);
    rows.push({ nm, kg, slope:sRaw, fnd, dsl, ok, D0, Dadj, estado, UA });
  }
  rows.sort((a,b)=> (b.estado - a.estado) || (b.kg - a.kg));
  return rows;
}

/* ===== Proyección Kg por consumo (solo si ocupado) ===== */
function projectedKg(nm, ds){
  const dEnd=parseDate(ds);
  const kg0 = kgFor(nm, ds);
  if (kg0==null) return null;
  const area = AREAS.get(nm)||0;
  const m = moves.get(nm)||[];
  const {UA, occ} = inferUAandOcc(m, dEnd, state.auKg);
  if (!occ || area<=0 || state.coefUso<=0) return kg0;

  const dLast = lastKgDate(nm, ds) || dEnd;
  const days = Math.max(0, daysBetween(dLast, dEnd));
  const fnd = FND.has(nm)? FND.get(nm) : null;
  const uso = state.coefUso/100;
  const base= state.consumo;
  const cons = (fnd==null)? base : clamp(base*(1 - state.params.alpha*fnd), 7, 14);

  const eatPerHaPerDay = (UA * cons) / (area * Math.max(uso, 1e-6));
  return Math.max(0, kg0 - days * eatPerHaPerDay);
}

/* ===== Render principal ===== */
function renderAll(){ renderMap(); renderKPIs(); renderKPIsPotrero(); drawChart('timeseries'); renderPastoreoChips(); renderRanking(); }

/* ===== Mapa / Leyenda ===== */
let legendCtl=null;
function renderMap(){
  const dEnd=parseDate(state.end); const ds=state.end;
  const breaks=computeBreaksBiomasa(dEnd);
  if (dslLayer) dslLayer.clearLayers();

  let minPET=null,maxPET=null;
  if (state.overlay==='pet0'){
    for(const nm of selectedParents()){
      const arr=pet0.get(nm)||[]; const v=lastOnOrBefore(arr,dEnd,'mm7d');
      if (v==null) continue; if (minPET==null||v<minPET) minPET=v; if (maxPET==null||v>maxPET) maxPET=v;
    }
    if (minPET==null){ minPET=-10; maxPET=10; }
  }

  const rankRows = state.overlay==='estado' ? computeRanking(ds) : [];
  const rankMap  = new Map(rankRows.map(r=>[r.nm, r.estado]));

  // *** NUEVO: mapa de Kg actual para exponer a addon ***
  const currentKgByPot = Object.create(null);

  if (!geoLayer) return;
  geoLayer.eachLayer(layer=>{
    const nm=layer.feature.properties.__canon; if(!nm) return;

    let fill='#ddd', stroke='#333', weight=1;

    const arr=series.get(nm)||[];
    const kg7=lastOnOrBefore(arr,dEnd,'kgms_7d');
    const kgR=lastOnOrBefore(arr,dEnd,'kgms_raw');
    const m=moves.get(nm)||[];
    const x = inferUAandOcc(m,dEnd,state.auKg);
    const occ=x.occ;
    const dslCalc=computeRestDaysFromEvents(m,dEnd);

    const kgUse=(state.fuente==='raw')? (kgR ?? kg7) : (kg7 ?? kgR);
    currentKgByPot[nm] = (kgUse!=null? Number(kgUse) : null);  // << expuesto abajo

    if (state.overlay==='biomasa'){
      fill=biomasaColor(kgUse,breaks);
    }else if (state.overlay==='descanso'){
      fill=biomasaColor(kgUse,breaks);
      if (PARENTS.has(nm) && dslCalc!=null && dslCalc>=0){
        const center=layer.getBounds().getCenter();
        const label=L.tooltip({permanent:true,className:'dsl-label',direction:'center',opacity:0.95}).setContent(String(dslCalc)).setLatLng(center);
        dslLayer.addLayer(label);
      }
    }else if (state.overlay==='estado'){
      const est=rankMap.get(nm); fill=(est===1)?'#22c55e':(est===0?'#f59e0b':'#ef4444');
    }else if (state.overlay==='kg_proj'){
      const v = projectedKg(nm, ds);
      fill = biomasaColor(v, breaks);
    }else{
      const arrP=pet0.get(nm)||[]; const v=lastOnOrBefore(arrP,dEnd,'mm7d'); fill=pet0Color(v,minPET,maxPET);
    }

    if (occ){ stroke='#c1121f'; weight=2; }
    layer.setStyle({fillColor:fill,color:stroke,weight,fillOpacity:.9});

    const area=AREAS.get(nm)||0; const fnd=FND.has(nm)?FND.get(nm):null;
    const kg = kgUse;
    const UA_for_days = (x.occ ? x.UA : 0);
    const {D0,Dadj} = computeDays(kg,area,UA_for_days,fnd);
    const kgP = (state.overlay==='kg_proj') ? projectedKg(nm, ds) : null;
    const smin = state.params.Smin;
    const warn = (kgP!=null && kgP < smin) ? ' <b style="color:#c1121f">⚠ Smin</b>' : '';

    // Tooltip UA: si viene de PV_total_kg, muestra conversión
    let uaTip = `UA: ${x.UA? nf1.format(x.UA):'0' }`;
    if (x?.row?.PV_total_kg) uaTip += ` (PV/UA≈ ${nf1.format(state.auKg)} kg)`;

    layer.bindPopup(`
      <div><strong>${nm}</strong></div>
      <div>Kg MS/ha (${state.fuente==='raw'?'raw':'7d'}): <b>${kg!=null?fmtK(kg):'–'}</b></div>
      ${kgP!=null? `<div>Kg proyectado (consumo): <b>${fmtK(kgP)}</b>${warn}</div>`:''}
      <div>${uaTip}</div>
      <div>Descanso (d): ${dslCalc!=null?dslCalc:'–'}</div>
      <div>Días brutos: ${D0!=null?fmt1(Math.max(0,D0)):'–'}</div>
      <div>Días ajustados: ${Dadj!=null?fmt1(Math.max(0,Dadj)):'–'}</div>
    `);
  });

  // *** NUEVO: exponer el mapa de Kg actual a addons ***
  window.PV6 = window.PV6 || {};
  PV6.ui = PV6.ui || {};
  PV6.ui.currentKgByPot = currentKgByPot;
  PV6.state = PV6.state || state;
  PV6.state.overlayByPot = currentKgByPot;

  if (legendCtl){ legendCtl.remove(); legendCtl=null; }
  legendCtl=L.control({position:'bottomright'});
  legendCtl.onAdd=function(){
    const div=L.DomUtil.create('div','legend');
    if (state.overlay==='biomasa' || state.overlay==='descanso' || state.overlay==='kg_proj'){
      const title = state.overlay==='kg_proj' ? 'Kg MS/ha proyectado' : 'Kg MS/ha';
      const b=breaks||[1500,2000,2500,3000];
      const colors=['#e8f5e9','#c8e6c9','#a5d6a7','#66bb6a','#2e7d32'];
      const ranges=[`<${Math.round(b[0])}`,`${Math.round(b[0])}–${Math.round(b[1])}`,`${Math.round(b[1])}–${Math.round(b[2])}`,`${Math.round(b[2])}–${Math.round(b[3])}`,`>${Math.round(b[3])}`];
      div.innerHTML=`<b>${title} (${state.fuente==='raw'?'raw':'7d'})</b>`;
      for(let i=0;i<5;i++){ const r=document.createElement('div'); r.className='item'; r.innerHTML=`<span class="sw" style="background:${colors[i]}"></span><span>${ranges[i]}</span>`; div.appendChild(r); }
      if (state.overlay==='descanso'){
        const hr=document.createElement('hr'); hr.style.border='0'; hr.style.borderTop='1px solid #e7e9ee'; hr.style.margin='4px 0'; div.appendChild(hr);
        const p=document.createElement('div'); p.innerHTML='Etiqueta: <b>DSL</b> (días de descanso)'; div.appendChild(p);
      }
    }else if (state.overlay==='estado'){
      div.innerHTML='<b>Estado (pastoreo)</b>';
      const items=[['#ef4444','No entrar'],['#f59e0b','Listos pronto'],['#22c55e','Entrar ahora']];
      items.forEach(([c,t])=>{ const r=document.createElement('div'); r.className='item'; r.innerHTML=`<span class="sw" style="background:${c}"></span><span>${t}</span>`; div.appendChild(r); });
    }else{
      div.innerHTML='<b>P–ET₀ (mm, 7d)</b>';
      const a=document.createElement('div'); a.className='item'; a.innerHTML=`<span class="sw" style="background:${pet0Color(-10,-10,10)}"></span><span>Seco</span>`;
      const m=document.createElement('div'); m.className='item'; m.innerHTML=`<span class="sw" style="background:${pet0Color(0,-10,10)}"></span><span>0</span>`;
      const b=document.createElement('div'); b.className='item'; b.innerHTML=`<span class="sw" style="background:${pet0Color(10,-10,10)}"></span><span>Húmedo</span>`;
      div.appendChild(a); div.appendChild(m); div.appendChild(b);
    }
    return div;
  };
  legendCtl.addTo(map);
}

/* ===== Chips (dos bloques) ===== */
function renderPastoreoChips(){
  const ds=state.end; const dEnd=parseDate(ds);
  const ranked=computeRanking(ds);

  const occ=[], free=[];
  for (const r of ranked){
    if (isZ(r.nm)) continue;
    const {occ:isOcc} = inferUAandOcc(moves.get(r.nm)||[], dEnd, state.auKg);
    const kgP = projectedKg(r.nm, ds);
    const smin = state.params.Smin;
    const alert = (kgP!=null && kgP < smin) ? ' ⚠' : '';
    const chip = { nm:r.nm, label:abbrev(r.nm)+alert, kg:(r.kg!=null?Math.round(r.kg):null), est:r.estado };
    (isOcc ? occ : free).push(chip);
  }
  const ord=(a,b)=> (b.est - a.est) || ((b.kg??-1) - (a.kg??-1));
  occ.sort(ord); free.sort(ord);

  const fill=(id, items, emptyTxt)=>{
    const el=document.getElementById(id); if(!el) return;
    el.innerHTML='';
    if(!items.length){ const p=document.createElement('div'); p.style.color='#6b7a8c'; p.textContent=emptyTxt; el.appendChild(p); return; }
    items.forEach(x=>{
      const d=document.createElement('div'); d.className='chip';
      d.style.borderColor = (x.est===1? '#22c55e' : (x.est===0? '#f59e0b' : '#ef4444'));
      d.dataset.nm=x.nm;
      d.innerHTML=`<span>${x.label}</span><small>${x.kg!=null?nf0.format(x.kg):'–'}</small>`;
      d.addEventListener('click', ()=>{
        state.scope=x.nm; const sel=document.getElementById('pot-select'); if (sel) sel.value=x.nm;
        state.overlay='estado'; const osel=document.getElementById('overlay'); if (osel) osel.value='estado';
        renderAll(); const lyr=geoLayer.getLayers().find(l=>l.feature.properties.__canon===x.nm); if(lyr) map.fitBounds(lyr.getBounds());
      });
      el.appendChild(d);
    });
  };

  const pillG=document.querySelector('.pastoreo-dynamic .pill.state-green');
  const pillY=document.querySelector('.pastoreo-dynamic .pill:not(.state-green)');
  if (pillG) pillG.textContent = `Ocupados (${occ.length})`;
  if (pillY) pillY.textContent = `Libres calificados (${free.length})`;

  fill('chips-green',  occ,  'Sin ocupados');
  fill('chips-yellow', free, 'Sin libres calificados');
}

/* ===== KPIs & series ===== */
function renderKPIs(){
  const names=selectedParents(); const dEnd=parseDate(state.end);
  let sumAreaW=0, sumKgArea=0, sumUA=0;
  for(const nm of names){
    const area=AREAS.get(nm)||0;
    const arr=series.get(nm)||[];
    const vPref=state.fuente==='raw' ? lastOnOrBefore(arr,dEnd,'kgms_raw') : lastOnOrBefore(arr,dEnd,'kgms_7d');
    const kgUse=(vPref==null)? lastOnOrBefore(arr,dEnd,'kgms_7d') : vPref;
    if (kgUse!=null && area>0){ sumKgArea+=kgUse*area; sumAreaW+=area; }
    const arrM=moves.get(nm)||[]; const {UA,occ}=inferUAandOcc(arrM,dEnd,state.auKg);
    sumUA += occ ? (UA||0) : 0;
  }
  const kgHaPond = sumAreaW>0? (sumKgArea/sumAreaW) : null;
  const oferta  = (sumKgArea * (state.coefUso/100));
  const demanda = (sumUA * state.consumo);
  const dias    = (demanda>0 && oferta>0) ? (oferta/demanda) : null;

  const set=(id,val)=>{ const el=document.getElementById(id); if (el) el.textContent=val; };
  set('kpi-biomasa-finca', kgHaPond!=null ? fmtK(kgHaPond) : '–');
  set('kpi-area-finca',    fmt1(AREA_TOTAL_CSV || sumAreaW));
  set('kpi-ua-finca',      nf1.format(sumUA));
  set('kpi-oferta-finca',  nf0.format(Math.round(oferta||0)));
  set('kpi-demanda-finca', nf0.format(Math.round(demanda||0)));
  set('kpi-dias-finca',    (dias!=null ? fmt1(dias) : '–'));
}

function renderKPIsPotrero(){
  const dEnd=parseDate(state.end);
  const nm=(state.scope && state.scope!=='__ALL__' && state.scope!=='__PADRES__')? state.scope : null;
  const set=(id,val)=>{ const el=document.getElementById(id); if(el) el.textContent=val; };
  if (!nm){ set('kpi-potrero-nombre','—'); set('kpi-biomasa-pot','—'); set('kpi-area-pot','—'); set('kpi-ua-pot','—'); set('kpi-oferta-pot','—'); set('kpi-dias-pot','—'); return; }
  const area=AREAS.get(nm)||0;
  const arr=series.get(nm)||[];
  const vPref=state.fuente==='raw' ? lastOnOrBefore(arr,dEnd,'kgms_raw') : lastOnOrBefore(arr,dEnd,'kgms_7d');
  const kgUse=(vPref==null)? lastOnOrBefore(arr,dEnd,'kgms_7d') : vPref;
  const m=moves.get(nm)||[]; const x=inferUAandOcc(m,dEnd,state.auKg);
  const oferta=(kgUse!=null ? kgUse*area*(state.coefUso/100) : 0);
  const demanda=(x.UA*state.consumo);
  const dias=(oferta>0 && demanda>0) ? (oferta/demanda) : null;

  set('kpi-potrero-nombre', nm);
  set('kpi-biomasa-pot', kgUse!=null ? fmtK(kgUse) : '—');
  set('kpi-area-pot', fmt1(area));
  set('kpi-ua-pot', nf1.format(x.occ?x.UA:0));
  set('kpi-oferta-pot', nf0.format(Math.round(oferta||0)));
  set('kpi-dias-pot', dias!=null ? fmt1(dias) : '—');
}

/* ===== Serie temporal ===== */
function drawChart(canvasId){
  const forcedStart=parseDate('2025-01-10');
  const dStart=new Date(Math.max(parseDate(state.start), forcedStart));
  const dEnd=parseDate(state.end);

  const labels=[]; for(let d=new Date(dStart); d<=dEnd; d.setDate(d.getDate()+1)) labels.push(toISO(d));
  const names=selectedParents();

  // finca series
  const kgF=[], petF=[];
  for(const iso of labels){
    const d=parseDate(iso);
    let sumKg=0, areaSum=0;
    for(const nm of names){
      const area=AREAS.get(nm)||0; if(area<=0) continue;
      const arr=series.get(nm)||[];
      let v=(state.fuente==='raw')? lastOnOrBefore(arr,d,'kgms_raw') : lastOnOrBefore(arr,d,'kgms_7d');
      if (v==null) v=lastOnOrBefore(arr,d,'kgms_7d');
      if (v!=null){ sumKg+=v*area; areaSum+=area; }
    }
    kgF.push(areaSum>0? sumKg/areaSum : null);

    let sum=0, n=0;
    for(const nm of names){
      const arr=pet0.get(nm)||[]; const v=lastOnOrBefore(arr,d,'mm7d');
      if (v!=null){ sum+=v; n++; }
    }
    petF.push(n>0 ? sum/n : null);
  }

  // potrero serie
  const nm=(state.scope && state.scope!=='__ALL__' && state.scope!=='__PADRES__')? state.scope : null;
  let pot=null;
  if (nm){
    pot=[]; const arr=series.get(nm)||[];
    for(const iso of labels){
      const d=parseDate(iso);
      let v=(state.fuente==='raw')? lastOnOrBefore(arr,d,'kgms_raw') : lastOnOrBefore(arr,d,'kgms_7d');
      if (v==null) v=lastOnOrBefore(arr,d,'kgms_7d');
      pot.push(v!=null? v : null);
    }
  }

  // downsampling para la grande
  let L=labels, KG=kgF, PET=petF, POT=pot;
  if (canvasId==='timeseries-big' && labels.length>220){
    const step=Math.ceil(labels.length/220);
    const ds = arr => arr.filter((_,i)=> i%step===0);
    L = ds(labels); KG = ds(kgF); PET=ds(petF); POT = pot ? ds(pot) : null;
  }

  const el=document.getElementById(canvasId); if (!el) return;
  const ctx=el.getContext('2d');
  if (canvasId==='timeseries' && chartSmall){ chartSmall.destroy(); chartSmall=null; }
  if (canvasId==='timeseries-big' && chartBig){ chartBig.destroy(); chartBig=null; }

  const datasets=[
    {label:`Kg MS/ha finca (${state.fuente==='raw'?'raw':'7d'})`, data:KG, borderWidth:1.2, tension:0.35, pointRadius:0, spanGaps:true, borderColor:'#2e7d32'},
    {label:'P–ET₀ finca (mm, 7d)', data:PET, yAxisID:'y1', borderWidth:1.1, tension:0.35, pointRadius:0, spanGaps:true, borderColor:'#1e88e5'}
  ];
  if (POT){ datasets.unshift({label:`Kg MS/ha ${nm} (${state.fuente==='raw'?'raw':'7d'})`, data:POT, borderWidth:1.4, tension:0.35, pointRadius:0, spanGaps:true, borderDash:[6,4], borderColor:'#1b5e20'}); }

  const options = {
    responsive:true, maintainAspectRatio:false, animation:false,
    interaction:{mode:'index',intersect:false},
    plugins:{ legend:{display:true} },
    scales:{ y:{title:{display:true,text:'Kg MS/ha'}}, y1:{position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'mm'}} }
  };

  const chart=new Chart(ctx,{ type:'line', data:{labels:L,datasets}, options });
  if (canvasId==='timeseries') chartSmall=chart; else chartBig=chart;
}

/* ===== Ranking ===== */
function renderRanking(){
  const tbody=document.getElementById('rank-body'); if(!tbody) return;
  const ds=state.end; const rows=computeRanking(ds);
  tbody.innerHTML='';
  rows.forEach(r=>{
    const tr=document.createElement('tr');
    const badge='<span class="'+(r.ok?'badge ok':'badge no')+'">'+(r.ok?'Sí':'No')+'</span>';
    const stateTxt= r.estado===1? '<span class="state green">Verde</span>' : (r.estado===0? '<span class="state yellow">Amarillo</span>' : '<span class="state red">Rojo</span>');
    tr.innerHTML=`<td style="text-align:left; cursor:pointer;">${abbrev(r.nm)}</td>
                  <td>${r.kg!=null?fmtK(r.kg):'–'}</td>
                  <td>${r.slope==null?'–':fmt1(r.slope)}</td>
                  <td>${r.fnd==null?'–':fmtK(r.fnd*100)+'%'}</td>
                  <td>${r.dsl==null?'–':r.dsl}</td>
                  <td>${badge}</td>
                  <td>${r.D0==null?'–':fmt1(r.D0)}</td>
                  <td>${r.Dadj==null?'–':fmt1(r.Dadj)}</td>
                  <td>${stateTxt}</td>`;
    tr.addEventListener('click', ()=>{ state.scope=r.nm; const sel=document.getElementById('pot-select'); if (sel) sel.value=r.nm; renderAll(); });
    tbody.appendChild(tr);
  });
}

/* ===== Parámetros (modal) ===== */

function openParamsModal(){
  const p = state.params;
  let modal = document.getElementById('params-modal-js');
  if (!modal){
    modal = document.createElement('div');
    modal.id = 'params-modal-js';
    modal.innerHTML = `
      <div class="modal-backdrop" data-close="params"></div>
      <div class="modal-card">
        <h3>Parámetros de pastoreo</h3>
        <div class="grid2">
          <label>Emin <input id="p-Emin" type="number"></label>
          <label>Emax <input id="p-Emax" type="number"></label>
          <label>Smin <input id="p-Smin" type="number"></label>
          <label>Smax <input id="p-Smax" type="number"></label>
          <label>α (FND) <input id="p-alpha" step="0.01" type="number"></label>
          <label>β (desperd.) <input id="p-beta" step="0.01" type="number"></label>
          <label>Wmax (cap) <input id="p-wmax" step="0.01" type="number"></label>
          <label>Descanso mín <input id="p-dslmin" type="number"></label>
          <label>Descanso máx <input id="p-dslmax" type="number"></label>
          <label>QC max edad (d) <input id="p-qc" type="number"></label>
        </div>
        <div class="row" style="margin-top:8px;display:flex;align-items:center;gap:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#444">
            <input type="checkbox" id="p-sticky" />
            <span>Guardar parámetros por <b>modo</b> (pegajosos al cambiar modo)</span>
          </label>
        </div>
        <div class="actions" style="display:flex;justify-content:space-between;gap:8px;margin-top:12px;flex-wrap:wrap">
          <div class="left" style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="p-export" class="btn">Exportar JSON</button>
            <button id="p-import" class="btn">Importar JSON</button>
            <input id="p-file" type="file" accept="application/json" style="display:none" />
          </div>
          <div class="right" style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="p-reset" class="btn">Restaurar fábrica</button>
            <button id="p-cancel" data-close="params" class="btn">Cancelar</button>
            <button id="p-save" class="primary">Guardar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const st=document.createElement('style'); st.textContent=`
      #params-modal-js{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999}
      #params-modal-js .modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.25)}
      #params-modal-js .modal-card{position:relative;background:#fff;border-radius:12px;padding:16px;min-width:520px;box-shadow:0 10px 40px rgba(0,0,0,.2);max-width:92vw}
      #params-modal-js h3{margin:0 0 8px 0}
      #params-modal-js .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #params-modal-js label{display:flex;flex-direction:column;font-size:12px;color:#555}
      #params-modal-js input{padding:6px 8px;border:1px solid #d0d7e2;border-radius:8px}
      #params-modal-js .primary{background:#2563eb;color:#fff;border:none;padding:8px 12px;border-radius:8px}
      #params-modal-js .btn{border:1px solid #cbd5e1;border-radius:8px;padding:6px 10px;background:#fff;cursor:pointer}
    `; document.head.appendChild(st);
  }
  const setV=(id,v)=>{ const el=document.querySelector('#params-modal-js '+id); if(el) el.value=v; };
  setV('#p-Emin',p.Emin); setV('#p-Emax',p.Emax); setV('#p-Smin',p.Smin); setV('#p-Smax',p.Smax);
  setV('#p-alpha',p.alpha); setV('#p-beta',p.beta); setV('#p-wmax',p.wmax); setV('#p-dslmin',p.dslmin); setV('#p-dslmax',p.dslmax);
  document.querySelector('#params-modal-js #p-qc').value = state.qcMaxAge;
  const ucfg0 = loadUserConfig() || {sticky:false};
  const stickyEl = document.querySelector('#params-modal-js #p-sticky');
  stickyEl.checked = !!ucfg0.sticky;

  modal.style.display='flex';

  const byId=s=>document.querySelector('#params-modal-js '+s);
  byId('#p-cancel').onclick = ()=> modal.style.display='none';

  byId('#p-save').onclick = ()=>{
    const getN = (id, fb) => {
      const el = byId(id);
      const v = Number(el && el.value);
      return Number.isFinite(v) ? v : fb;
    };
    p.Emin   = getN('#p-Emin', p.Emin);
    p.Emax   = getN('#p-Emax', p.Emax);
    p.Smin   = getN('#p-Smin', p.Smin);
    p.Smax   = getN('#p-Smax', p.Smax);
    p.alpha  = getN('#p-alpha', p.alpha);
    p.beta   = getN('#p-beta', p.beta);
    p.wmax   = getN('#p-wmax', p.wmax);
    p.dslmin = getN('#p-dslmin', p.dslmin);
    p.dslmax = getN('#p-dslmax', p.dslmax);
    state.qcMaxAge = getN('#p-qc', state.qcMaxAge);

    const cfg = loadUserConfig() || { sticky:false, per_mode:{}, global:{} };
    cfg.sticky = stickyEl.checked;
    cfg.last_mode = state.mode;
    cfg.updated_at = new Date().toISOString();

    if (cfg.sticky){
      if (!cfg.per_mode[state.mode]) cfg.per_mode[state.mode] = {};
      cfg.per_mode[state.mode].params = Object.assign({}, p);
      cfg.per_mode[state.mode].weights = Object.assign({}, (state.weights?.[state.mode]||{}));
      cfg.global = Object.assign({}, cfg.global, { qcMaxAge: state.qcMaxAge, auKg: state.auKg, coefUso: state.coefUso, consumo: state.consumo });
    }else{
      cfg.global.params = Object.assign({}, p);
      cfg.global.weights = Object.assign({}, (state.weights?.[state.mode]||{}));
      cfg.global.qcMaxAge = state.qcMaxAge;
      cfg.global.auKg = state.auKg;
      cfg.global.coefUso = state.coefUso;
      cfg.global.consumo = state.consumo;
    }
    saveUserConfig(cfg);
    modal.style.display='none';
    renderAll();
  };

  byId('#p-export').onclick = ()=>{
    const cfg = loadUserConfig() || { sticky:false, per_mode:{}, global:{} };
    const blob = new Blob([JSON.stringify(cfg, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='PV6_user_params.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  };

  byId('#p-import').onclick = ()=>{
    const fi = byId('#p-file'); fi.value = '';
    fi.onchange = ()=>{
      const f = fi.files && fi.files[0]; if(!f) return;
      const rd = new FileReader();
      rd.onload = ()=>{
        try{
          const cfg = JSON.parse(rd.result);
          saveUserConfig(cfg);
          if (cfg.global && cfg.global.params) Object.assign(state.params, cfg.global.params);
          if (cfg.sticky && cfg.per_mode && cfg.per_mode[state.mode] && cfg.per_mode[state.mode].params){
            Object.assign(state.params, cfg.per_mode[state.mode].params);
          }
          modal.style.display='none';
          renderAll();
        }catch(e){ alert('Archivo inválido'); }
      };
      rd.readAsText(f);
    };
    fi.click();
  };

  byId('#p-reset').onclick = ()=>{
    localStorage.removeItem(LS_KEY);
    alert('Parámetros de usuario borrados. Se usarán los de fábrica.');
    modal.style.display='none';
    location.reload();
  };

  document.addEventListener('keydown', function onEsc(e){
    if (e.key==='Escape'){ modal.style.display='none'; document.removeEventListener('keydown', onEsc); }
  }, {once:true});
}


/* ===== Chart modal ===== */
function openChartModal(){
  let modal=document.getElementById('chart-modal-js');
  if (!modal){
    modal=document.createElement('div'); modal.id='chart-modal-js';
    modal.innerHTML=`
      <div class="backdrop" data-close="chart" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"></div>
      <div class="card" style="position:fixed;inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);
           width:min(1200px,95vw);height:min(700px,90vh);background:#fff;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.2);display:flex;flex-direction:column;z-index:99999">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #e8ecf3">
          <h3 style="margin:0">Serie temporal</h3>
          <button id="collapse-chart-js" data-close="chart" class="btn">Cerrar</button>
        </div>
        <div style="flex:1;padding:8px"><canvas id="timeseries-big"></canvas></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#collapse-chart-js').onclick = ()=>{ modal.style.display='none'; if (window.chartBig){ try{chartBig.destroy();}catch(e){} chartBig=null; } };
    modal.querySelector('.backdrop').onclick = ()=>{ modal.style.display='none'; if (window.chartBig){ try{chartBig.destroy();}catch(e){} chartBig=null; } };
    document.addEventListener('keydown', function onEsc(e){
      if (e.key==='Escape'){ modal.style.display='none'; if (window.chartBig){ try{chartBig.destroy();}catch(e){} chartBig=null; } document.removeEventListener('keydown', onEsc); }
    });
  }
  modal.style.display='block';
  requestAnimationFrame(()=> drawChart('timeseries-big'));
}
