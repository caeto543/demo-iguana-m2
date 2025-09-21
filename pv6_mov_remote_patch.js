// PV6 — parche remoto para MOV_GANADO_CARGA_MIX.csv
(function(){
  const SHEETS_URL = (typeof window !== 'undefined' && window.__PV6_SHEETS_MOV_URL__) || '';
  const MOV_NAME = 'MOV_GANADO_CARGA_MIX.csv';
  if (!SHEETS_URL) { console.warn('[MOV][patch] URL de Sheets no definida — usando CSV local.'); return; }
  const origFetch = window.fetch;
  window.fetch = async function(resource, init){
    try{
      const url = (typeof resource === 'string') ? resource : (resource && resource.url) || '';
      if (url && url.toLowerCase().includes(MOV_NAME.toLowerCase())){
        const res = await origFetch(SHEETS_URL, init);
        if (!res.ok) return res;
        const text = await res.text();
        let count = 0;
        try{ const parsed = Papa.parse(text, {header:true, dynamicTyping:true, skipEmptyLines:true});
             const data = (parsed && parsed.data) ? parsed.data.filter(r=>Object.keys(r).length>0) : [];
             count = data.length; }catch(_){}
        console.log(`[MOV][patch] intercept → remoto OK (${count} filas)`);
        return new Response(text, {status:200, headers:{'Content-Type':'text/csv; charset=utf-8'}});
      }
      return origFetch(resource, init);
    }catch(e){ return origFetch(resource, init); }
  };
})();
