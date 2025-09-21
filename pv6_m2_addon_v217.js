/* PV6 — M2.17 vista separada (m2.html)
   - Lee chips de "Ocupados" y "Libres calificados"
   - Filtra potreros contra Nombres_area_iguana.csv (ASCII)
   - FDN de Iguana_FND_por_potrero.csv
   - Cálculos: Días br., Días FDN (120/FDN), Δ desperd. = min(wmax, β*Dfdn), Días aj. = max(Dbr, Dfdn-Δ)
   - Destino: Ninguno, Sugeridos (top Kg), Todos (excluye prefijo Z)
*/
(function(){
  // ========= UI =========
  function el(tag, attrs={}, html=''){ const n=document.createElement(tag); for(const k in attrs) n.setAttribute(k, attrs[k]); if(html!=null) n.innerHTML=html; return n; }
  function css(node, s){ node.style.cssText=s; return node; }
  const fmt = n => (n==null || !isFinite(n)) ? '–' : (Math.round(n*10)/10).toLocaleString('es-CO');
  const num = t => (t||'').toString().replace(/[^\d.,-]/g,'').replace(/\.(?=\d{3}\b)/g,'').replace(',', '.');
  const norm = s => (s||'').trim().toUpperCase().replace(/\s+/g,'_');
  function daysFDN(f){ if(f==null||!isFinite(f)||f<=0) return null; const pct=(f<=1)?f*100:f; return 120/pct; }

  function buildPanel(){
    if (document.getElementById('pv6-m2')) return;
    const card=css(el('section',{id:'pv6-m2'}),`
      position:fixed;right:16px;bottom:16px;width:720px;max-height:70vh;overflow:auto;
      background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 10px 25px rgba(0,0,0,.12);z-index:9999`);
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #eef2f7">
        <div style="font-weight:600">Pastoreo con manejo (PV6)</div>
        <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:#334155">
          <label>UA</label><input id="m2-ua" type="number" min="0" step="1" style="width:80px;padding:4px;border:1px solid #d1d5db;border-radius:8px">
          <label>Coef. uso (%)</label><input id="m2-coef" type="number" min="0" max="100" step="1" value="60" style="width:70px;padding:4px;border:1px solid #d1d5db;border-radius:8px">
          <label>Consumo (kg/UA/d)</label><input id="m2-base" type="number" min="1" step="1" value="10" style="width:80px;padding:4px;border:1px solid #d1d5db;border-radius:8px">
          <button id="m2-recalc" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:8px;background:#f8fafc;cursor:pointer">Recalcular</button>
        </div>
      </div>
      <div style="padding:10px 14px;display:flex;gap:10px;align-items:center">
        <div><b>Origen:</b> <span id="m2-origen" style="color:#334155">ocupados (a la fecha “hasta”)</span></div>
        <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
          <label style="font-size:12px;color:#475569">Destino</label>
          <select id="m2-dest" style="min-width:260px;padding:6px;border:1px solid #d1d5db;border-radius:8px"></select>
        </div>
      </div>
      <div style="padding:0 14px 12px 14px">
        <div class="table-wrap" style="max-height:48vh;overflow:auto;border:1px solid #eef2f7;border-radius:12px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead><tr>
              <th style="text-align:left;padding:8px;border-bottom:1px solid #eef2f7">Potrero</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Kg MS/ha</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Área (ha)</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Días br.</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Días FDN</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Δ desperd. (d)</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Días aj.</th>
              <th style="padding:8px;border-bottom:1px solid #eef2f7">Estado</th>
            </tr></thead>
            <tbody id="m2-body"><tr><td colspan="8" style="padding:10px;color:#64748b">Cargando…</td></tr></tbody>
          </table>
        </div>
        <div id="m2-status" style="margin-top:8px;color:#64748b;font-size:12px"></div>
      </div>`;
    document.body.appendChild(card);
    document.getElementById('m2-recalc').addEventListener('click', ()=>render());
  }

  // ========= Datos =========
  const AREAS=new Map(), FND=new Map(), VALID=new Set();
  async function loadCSV(){
    const [areasTxt,fndTxt]=await Promise.all([
      fetch('Nombres_area_iguana.csv').then(r=>r.text()).catch(()=>''), 
      fetch('Iguana_FND_por_potrero.csv').then(r=>r.text()).catch(()=> '')
    ]);
    areasTxt.split(/\r?\n/).forEach(line=>{
      const c=line.split(',');
      if(c.length<2) return;
      const k=norm(c[0]);
      const ha=parseFloat(num(c[1]||c[c.length-1]||''));
      if(k && isFinite(ha)){ AREAS.set(k,ha); VALID.add(k); }
    });
    fndTxt.split(/\r?\n/).forEach(line=>{
      const c=line.split(',');
      if(c.length<2) return;
      const k=norm(c[0]);
      const f=parseFloat(num(c[1]||c[c.length-1]||''));
      if(k && isFinite(f)) FND.set(k,f);
    });
  }

  function readChips(){
    const out=[];
    const pick=re=>{
      const nodes=[...document.querySelectorAll('h1,h2,h3,h4,div,span')];
      const hdr=nodes.find(el=>re.test((el.textContent||'').trim()));
      return hdr ? (hdr.closest('section,div,article')||hdr.parentElement) : null;
    };
    const c1=pick(/^\s*Ocupados/i), c2=pick(/^\s*Libres\s+calificados/i);
    [c1,c2].filter(Boolean).forEach(c=>{
      [...c.querySelectorAll('button,a,span,div')].forEach(el=>{
        const tx=(el.textContent||'').trim().replace(/\s+/g,' ');
        const m=tx.match(/^([A-Z]+[0-9A-Z]{1,3})\b.*?([12]\.\d{3}|\d{3,4})$/); // PV3 2.246
        if(!m) return;
        const nm=m[1].trim();
        const kg=parseFloat(num(m[2]));
        const key=norm(nm);
        if(nm && isFinite(kg) && VALID.has(key)) out.push({nm,kg});
      });
    });
    const seen=new Set(), uniq=[];
    out.sort((a,b)=>b.kg-a.kg).forEach(r=>{ const k=norm(r.nm); if(!seen.has(k)){ seen.add(k); uniq.push(r);} });
    return uniq;
  }

  function autollenarUA(){
    const ua=document.getElementById('m2-ua');
    if(!ua || ua.value) return;
    const demNode=[...document.querySelectorAll('div,section,span,strong,h3')].find(el=>/Demanda\s+diaria\s*\(Finca\)/i.test(el.textContent||''));
    const base=parseFloat(num((document.getElementById('m2-base')||{}).value||'10'))||10;
    if(demNode){
      const numEl=(demNode.parentElement||demNode).querySelector('div,span,strong');
      const dem=numEl? parseFloat(num(numEl.textContent)) : null;
      if(isFinite(dem) && base>0) ua.value = Math.round(dem/base);
    }
  }

  function fillDestino(rows){
    const sel=document.getElementById('m2-dest');
    if(!sel) return;
    sel.innerHTML='';
    sel.appendChild(el('option',{value:''}, '— Ningún potrero (salida de finca) —'));
    const libres = rows.slice().filter(r=>!/^Z/i.test(r.nm));
    const sug = libres.slice(0,10);
    if(sug.length){
      const og=el('optgroup',{label:'Sugeridos (top por Kg)'});
      sug.forEach(r=>og.appendChild(el('option',{value:r.nm}, `${r.nm} (${Math.round(r.kg).toLocaleString('es-CO')})`)));
      sel.appendChild(og);
    }
    const og2=el('optgroup',{label:'Todos'});
    libres.forEach(r=>og2.appendChild(el('option',{value:r.nm}, r.nm)));
    sel.appendChild(og2);
  }

  function render(){
    const status=document.getElementById('m2-status');
    const body=document.getElementById('m2-body');
    const uaEl=document.getElementById('m2-ua');
    const coefEl=document.getElementById('m2-coef');
    const baseEl=document.getElementById('m2-base');

    const UA = uaEl && uaEl.value ? parseFloat(uaEl.value) : null;
    const coefUso = parseFloat(num(coefEl.value||'60')) || 60;
    const base = parseFloat(num(baseEl.value||'10')) || 10;
    const uso = coefUso/100;

    const rows=readChips();       // ya filtrados por VALID
    fillDestino(rows);

    status.textContent = `[M2.17] listo — fuente: chips+CSV — AREAS:${AREAS.size} FND:${FND.size} — UA:${UA??'–'} coef:${coefUso}% base:${base}`;
    body.innerHTML='';

    const beta=0.05, wmax=0.30;

    rows.forEach(r=>{
      const key=norm(r.nm);
      const ha  = AREAS.get(key);
      const fnd = FND.get(key);

      const oferta = (isFinite(r.kg)&&isFinite(ha)) ? (r.kg*ha*uso) : null;          // kg totales
      const demanda = (UA!=null && isFinite(UA)) ? (UA*base) : null;                // kg/día
      const Dbr = (oferta!=null && demanda!=null && demanda>0)? (oferta/demanda) : null;

      const Dfdn = daysFDN(fnd);
      const delta = (Dfdn==null)? null : Math.min(wmax, beta*Dfdn);
      const Daj = (Dbr==null && Dfdn==null) ? null
                : (Dbr==null) ? Math.max(0,(Dfdn||0)-(delta||0))
                : (Dfdn==null) ? Dbr
                : Math.max(Dbr, Dfdn - (delta||0));

      const estado = (r.kg>=2000&&r.kg<=3200) ? 'Verde' : (r.kg>=1600) ? 'Amarillo' : 'Rojo';
      const pill = estado==='Verde' ? 'background:#22c55e1a;color:#16a34a;border:1px solid #22c55e33;padding:2px 8px;border-radius:9999px'
                 : estado==='Amarillo' ? 'background:#f59e0b1a;color:#d97706;border:1px solid #f59e0b33;padding:2px 8px;border-radius:9999px'
                 : 'background:#ef44441a;color:#dc2626;border:1px solid #ef444433;padding:2px 8px;border-radius:9999px';

      const tr=el('tr',{},`
        <td style="text-align:left;padding:8px">${r.nm}</td>
        <td style="text-align:right;padding:8px">${Math.round(r.kg).toLocaleString('es-CO')}</td>
        <td style="text-align:right;padding:8px">${isFinite(ha)? fmt(ha):'–'}</td>
        <td style="text-align:right;padding:8px">${fmt(Dbr)}</td>
        <td style="text-align:right;padding:8px">${fmt(Dfdn)}</td>
        <td style="text-align:right;padding:8px">${fmt(delta)}</td>
        <td style="text-align:right;padding:8px">${fmt(Daj)}</td>
        <td style="padding:8px;text-align:center"><span style="${pill}">${estado}</span></td>`);
      body.appendChild(tr);
    });
    return true;
  }

  async function start(){
    buildPanel();
    await loadCSV();
    autollenarUA();

    // primer render (con retries por si el mapa/DOM aún arma los chips)
    let tries=0; const iv=setInterval(()=>{
      tries++; if(render()) { clearInterval(iv); }
      if(tries>40) clearInterval(iv);
    }, 300);

    // re-render básico cuando cambien inputs
    ['m2-ua','m2-coef','m2-base'].forEach(id=>{
      const e=document.getElementById(id);
      if(e) e.addEventListener('change', ()=>render());
    });
    window.addEventListener('scroll', ()=>render(), {passive:true});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
