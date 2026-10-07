import { local } from './offline.js';
(function browserApp() {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const root = $('#app'), modalRoot = $('#modal-root');
  let state, user, storeId = '', view = 'dashboard', search = '', category = '', stockFilter = '', documentFilter = '', syncing = false, pending = [], demoMode = false, cached = false, toastTimer, reportPeriod = 'month';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const num = value => new Intl.NumberFormat('fr-FR', {maximumFractionDigits:3}).format(value || 0);
  const money = value => new Intl.NumberFormat('fr-FR', {style:'currency',currency:state?.settings?.currency || 'XOF',maximumFractionDigits:0}).format(value || 0);
  const businessDay = value => new Intl.DateTimeFormat('en-CA', {timeZone:'Africa/Porto-Novo',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  const today = () => businessDay(new Date());
  const date = value => new Intl.DateTimeFormat('fr-FR', {timeZone:'Africa/Porto-Novo',day:'2-digit',month:'short',year:'numeric'}).format(new Date(value));
  const firstDay = days => {const day=new Date();day.setUTCDate(day.getUTCDate()-days+1);return businessDay(day);};
  const product = id => state.products.find(p => p.id === id) || {name:'Article supprimé',sku:'—',color:'#eee'};
  const storeName = id => state.stores.find(s => s.id === id)?.name || 'Tous les magasins';
  const contactName = id => state.contacts.find(c => c.id === id)?.name || 'Client comptoir';
  const admin = () => user?.role === 'admin';
  const prices = () => user?.role !== 'inventory' && !state?.settings?.noPrices;
  const qty = (productId, sid = storeId) => state.stocks.filter(s => s.productId === productId && (sid === 'all' || s.storeId === sid)).reduce((sum,s) => sum+s.quantity,0);
  const docs = () => state.documents.filter(d => storeId === 'all' || d.storeId === storeId || d.toStoreId === storeId);
  const typeNames = {sale:'Vente',purchase:'Achat',transfer:'Transfert',adjustment:'Ajustement'};
  const typeTone = {sale:'success',purchase:'purple',transfer:'neutral',adjustment:'warning'};
  const roleNames = {admin:'Administrateur',cashier:'Caissier',inventory:"Agent d’inventaire"};
  const paths = {
    box:'<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
    grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    layers:'<path d="m12 3 10 6-10 6L2 9l10-6ZM2 13l10 6 10-6M2 17l10 6 10-6"/>',
    arrows:'<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4 4-4-4 4-4"/>',
    clipboard:'<rect x="5" y="5" width="14" height="17" rx="2"/><rect x="9" y="2" width="6" height="5" rx="1"/><path d="m9 14 2 2 4-4"/>',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chart:'<path d="M3 3v18h18M8 16v-5M13 16V7M18 16V4"/>',
    settings:'<path d="m9 3-1 3-3 1v4l3 1 1 3h4l1-3 3-1V7l-3-1-1-3H9Z" transform="translate(1 2)"/><circle cx="12" cy="11" r="3"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    down:'<path d="m6 9 6 6 6-6"/>',
    download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    alert:'<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01"/>',
    wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h2"/>',
    trend:'<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>',
    cart:'<path d="M2 3h3l3 13h11l3-9H6"/><circle cx="9" cy="21" r="1"/><circle cx="19" cy="21" r="1"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 1M18 18a8 8 0 0 1-13-1"/>',
    store:'<path d="M3 10 5 3h14l2 7M3 10v11h18V10M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 21v-7h6v7"/>',
    logout:'<path d="M9 3H4v18h5M13 8l5 4-5 4M8 12h10"/>',
    menu:'<path d="M3 6h18M3 12h18M3 18h18"/>',
    print:'<path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6zM17 11h.01"/>',
    edit:'<path d="m15 4 5 5M3 21l5-1L21 7l-5-5L3 15v6Z"/>',
    wifi:'<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01"/>',
    leaf:'<path d="M20 3c-8-1-15 3-15 10a6 6 0 0 0 6 6c7 0 10-8 9-16ZM3 21 15 9"/>',
    eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'
  };
  const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
  const btn = (label, action, name='plus', cls='primary', attrs='') => `<button class="btn ${cls}" data-action="${action}" ${attrs}>${icon(name)}${label}</button>`;
  const badge = (label,tone='neutral') => `<span class="badge ${tone}">${label}</span>`;
  function toast(message, error=false) {
    clearTimeout(toastTimer);
    $('#toast-root').innerHTML = `<div class="toast ${error?'error':'success'}" role="status">${icon(error?'alert':'check')}<span>${esc(message)}</span></div>`;
    toastTimer = setTimeout(()=>$('#toast-root').innerHTML='',5500);
  }
  async function api(path, data) {
    const response = await fetch(path, {method:data ? 'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000)});
    const body = await response.json();
    if (!response.ok) { const error = new Error(body.error || 'Cette opération a échoué.'); error.status=response.status; error.code=body.code; throw error; }
    return body;
  }
  async function refresh() {
    const incoming = await api('/api/state');
    state = incoming; user = state.user; cached=false;
    state.products ||= []; state.stores ||= []; state.stocks ||= []; state.documents ||= []; state.contacts ||= []; state.inventories ||= []; state.expenses ||= [];
    if (storeId !== 'all' && !state.stores.some(s=>s.id===storeId)) storeId=state.stores[0]?.id||'all';
    await local.set('state:'+user.id,state);
    await local.set('lastUser',user);
    pending = await local.pending(user.id);
  }
  async function command(type,payload) {
    const item={id:crypto.randomUUID(),type,payload,userId:user.id,queuedAt:Date.now()};
    // Persist before sending: interrupted responses can be retried safely with this ID.
    await local.enqueue(item);
    pending=await local.pending(user.id);
    if (!navigator.onLine) {
      render();
      return {queued:true};
    }
    try {
      await api('/api/commands',{id:item.id,type,payload});
      await local.removeCommand(item.id);
      try { await refresh(); }
      catch { cached=true; pending=await local.pending(user.id); }
      render();
      return {queued:false};
    } catch(error) {
      if(error.status===401){user=null;closeModal();renderLogin('Session expirée. Votre saisie a été conservée ; reconnectez-vous pour la synchroniser.');return {queued:true};}
      if (error.status) {
        await local.removeCommand(item.id);
        pending=await local.pending(user.id);
        render();
        throw error;
      }
      cached=true;
      render();
      return {queued:true};
    }
  }
  async function perform(type,payload,message) {
    const result=await command(type,payload);
    toast(result.queued?'Saisie conservée sur cet appareil, en attente de validation.':message);
    return result;
  }
  let syncTask=null;
  function sync() {
    if(syncTask)return syncTask;
    if(!user || !navigator.onLine)return Promise.resolve();
    syncTask=runSync().finally(()=>{syncTask=null;});
    return syncTask;
  }
  async function runSync() {
    syncing=true; updateSync();
    try {
      pending=await local.pending(user.id);
      for (const item of pending) {
        if (item.error) break;
        try {
          await api('/api/commands',{id:item.id,type:item.type,payload:item.payload});
          await local.removeCommand(item.id);
        } catch(error) {
          if (error.status === 401) throw error;
          if (error.status) {
            item.error=error.message;
            await local.enqueue(item);
            toast('Une saisie nécessite votre attention : '+error.message,true);
          } else console.warn('Envoi à reprendre :',error.name,error.message);
          break;
        }
      }
      await refresh(); render();
    } catch(error) {
      if(error.status===401){user=null;closeModal();renderLogin('Session expirée. Reconnectez-vous pour retrouver et synchroniser vos saisies.');}
      else {console.warn('Reprise de synchronisation :',error.name,error.message);cached=true;updateSync();}
    }
    finally { syncing=false; updateSync(); }
  }
  function updateSync() {
    const el=$('#sync-state'); if (!el) return;
    const label=!navigator.onLine?'Hors ligne':syncing?'Synchronisation…':pending.length?`${pending.length} en attente`:'À jour';
    el.className='sync-pill '+(!navigator.onLine?'offline':pending.length?'pending':'online');
    el.innerHTML=icon(!navigator.onLine?'wifi':pending.length?'clock':'check')+label;
  }
  function filteredProducts() {
    return state.products.filter(p => (!search || normalize([p.name,p.sku,p.category,p.brand,...(p.tags||[]),p.location].join(' ')).includes(normalize(search))) && (!category || p.category===category) && (!stockFilter || (stockFilter==='low' ? qty(p.id)<=p.minStock : stockFilter==='out' ? qty(p.id)===0 : qty(p.id)>p.minStock)));
  }
  const avatar = p => p.photo ? `<img class="product-avatar" src="${esc(p.photo)}" alt="" loading="lazy">` : `<span class="product-avatar" style="--product-color:${/^#[0-9a-f]{3,8}$/i.test(p.color||'')?p.color:'#ece8ff'}">${icon(p.category?.toLowerCase().includes('boisson')?'leaf':'box')}</span>`;
  const productCell = p => `<div class="product-cell">${avatar(p)}<div><div class="product-name">${esc(p.name)}</div><div class="product-sku">${esc(p.sku)} · ${esc(p.unit)}</div></div></div>`;
  function stockCell(p) {
    const q=qty(p.id); const percent=Math.min(100,Math.max(5,q/(Math.max(p.minStock,1)*4)*100));
    return `<span class="stock-number">${num(q)} <small>${esc(p.unit)}</small></span><div class="stock-bar ${q<=p.minStock?'low':''}"><i style="width:${percent}%"></i></div>`;
  }
  function stockBadge(p) {
    const q=qty(p.id); return q===0?badge('Rupture','danger'):q<=p.minStock?badge('Stock faible','warning'):badge('En stock','success');
  }
  function heading(eyebrow,title,subtitle,actions='') {
    return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
  }
  function metric(label,value,foot,name,tone) {
    return `<div class="metric-card"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon" data-tone="${tone}">${icon(name)}</span></div><div class="metric-value">${value}</div><div class="metric-footer">${foot}</div></div>`;
  }
  function empty(title,detail,name='box') {
    return `<div class="empty-state">${icon(name)}<h3>${title}</h3><p>${detail}</p></div>`;
  }
  function render() {
    if (!state || !user) return;
    const navigation = [
      ['dashboard','Vue d’ensemble','grid',true],
      ['products','Catalogue produits','box',true],
      ['documents','Mouvements','arrows',user.role!=='inventory'],
      ['inventories','Inventaires','clipboard',user.role!=='cashier'],
      ['contacts','Clients & fournisseurs','users',user.role!=='inventory'],
      ['reports','Rapports & analyses','chart',admin()],
      ['settings','Paramètres','settings',admin()]
    ].filter(n=>n[3]);
    if (!navigation.some(n=>n[0]===view)) view='dashboard';
    const content = ({dashboard:dashboard,products:productsPage,documents:documentsPage,inventories:inventoriesPage,contacts:contactsPage,reports:reportsPage,settings:settingsPage})[view]();
    root.innerHTML = `<div class="app-shell">
      <aside class="sidebar" aria-label="Navigation principale">
        <a href="#" class="brand" data-view="dashboard"><span class="brand-icon">${icon('box')}</span>comptoir<span class="brand-dot">.</span></a>
        <div class="brand-tag">VOTRE COMMERCE, EN CLAIR</div>
        <div class="store-card">${icon('store')}<div><strong>${esc(state.settings.businessName)}</strong><span>Espace de gestion</span></div>${badge('PRO','purple')}</div>
        <div class="nav-section">ESPACE DE TRAVAIL</div>
        <nav>${navigation.map(([id,label,name])=>`<button class="nav-item ${view===id?'active':''}" data-view="${id}"><span class="nav-icon">${icon(name)}</span>${label}${id==='products'?`<span class="nav-count" aria-hidden="true">${state.products.length}</span>`:''}</button>`).join('')}</nav>
        <div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<strong>Chaque article compte.</strong><p>Un stock bien suivi, un commerce qui grandit.</p></div><button class="nav-item" data-action="logout">${icon('logout')}Se déconnecter</button><div class="sidebar-version">Comptoir · Première version</div></div>
      </aside>
      <div class="sidebar-scrim" data-action="close-nav"></div>
      <main class="main">
        <header class="topbar"><div class="breadcrumb"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Ouvrir le menu">${icon('menu')}</button><span>Espace de travail</span>${icon('chevron')}<strong>${navigation.find(n=>n[0]===view)?.[1]}</strong></div><div class="top-actions"><button id="sync-state" class="sync-pill" data-action="sync" title="Synchroniser et voir les saisies en attente"></button><span class="topbar-divider"></span><div class="user-menu"><span class="avatar">${esc(user.name?.split(' ').map(x=>x[0]).slice(0,2).join('') || 'AD')}</span><div><strong>${esc(user.name || user.email)}</strong><small>${roleNames[user.role]}</small></div></div></div></header>
        <div class="content">${cached?`<div class="callout">${icon('wifi')}Données conservées sur cet appareil. Les nouvelles saisies attendront la connexion au serveur.</div>`:''}${state.settings.noPrices?'<div class="no-price-banner">Mode sans prix · Le suivi des quantités reste actif.</div>':''}${content}<footer class="footer"><span>${esc(state.settings.businessName)} · ${state.stores.length} magasins</span><span>${cached?'Données locales':'Données du serveur'} · ${date(new Date())}</span></footer></div>
      </main></div>`;
    updateSync(); bindShell();
  }
  function bindShell() {
    $$('[data-view]',root).forEach(el=>el.addEventListener('click',event=>{event.preventDefault();view=el.dataset.view;search='';category='';document.body.classList.remove('nav-open');render();}));
    $$('[data-action]',root).forEach(el=>el.addEventListener('click',()=>action(el.dataset.action,el.dataset)));
    $('#store-select')?.addEventListener('change',event=>{storeId=event.target.value;render();});
    $('#product-search')?.addEventListener('input',event=>{
      search=event.target.value; const start=event.target.selectionStart; render();const input=$('#product-search');input.focus();input.setSelectionRange(start,start);
    });
    $('#category-filter')?.addEventListener('change',event=>{category=event.target.value;render();});
    $('#stock-filter')?.addEventListener('change',event=>{stockFilter=event.target.value;render();});
    $('#document-filter')?.addEventListener('change',event=>{documentFilter=event.target.value;render();});
    $('#report-period')?.addEventListener('change',event=>{reportPeriod=event.target.value;render();});
    $$('[data-edit-product]',root).forEach(el=>el.addEventListener('click',()=>productForm(el.dataset.editProduct)));
    $$('[data-document]',root).forEach(el=>el.addEventListener('click',()=>receipt(el.dataset.document)));
    $$('[data-inventory]',root).forEach(el=>el.addEventListener('click',()=>inventoryDetail(el.dataset.inventory)));
    $$('[data-contact]',root).forEach(el=>el.addEventListener('click',()=>contactDetail(el.dataset.contact)));
    $('#settings-form')?.addEventListener('submit',async event=>{
      event.preventDefault();
      const form=event.currentTarget,button=$('[type=submit]',form);button.disabled=true;
      try {await perform('settings.update',{businessName:form.elements.businessName.value,noPrices:form.elements.noPrices.checked},'Préférences enregistrées.');}
      catch(error){toast(error.message,true);button.disabled=false;}
    });
  }
  const storeSelect = () => `<select id="store-select" class="select" aria-label="Magasin"><option value="all">Tous les magasins</option>${state.stores.map(s=>`<option value="${s.id}" ${s.id===storeId?'selected':''}>${esc(s.name)}</option>`).join('')}</select>`;
  function dashboard() {
    const low=state.products.filter(p=>qty(p.id)<=p.minStock);
    const valuation=state.products.reduce((sum,p)=>sum+qty(p.id)*(p.purchasePrice||0),0);
    const retailValue=state.products.reduce((sum,p)=>sum+qty(p.id)*(p.sellingPrice||0),0);
    const sales=docs().filter(d=>d.type==='sale');
    const daily=sales.filter(d=>d.date?.slice(0,10)===today()).reduce((sum,d)=>sum+d.total,0);
    const receivables=sales.reduce((sum,d)=>sum+Math.max(0,d.total-d.paid),0);
    const inProgress=state.inventories.filter(i=>i.status==='draft'&&(storeId==='all'||i.storeId===storeId)).length;
    const metrics = [
      metric('Références actives',num(state.products.length),`${icon('box')} Votre catalogue à portée de main`,'box','purple'),
      prices()&&admin()?metric('Valeur du stock',money(valuation),`Au coût d’achat · ${money(retailValue)} à la vente`,'wallet','blue'):metric('Unités en stock',num(state.products.reduce((sum,p)=>sum+qty(p.id),0)),'Somme indicative, unités de mesure mixtes','layers','blue'),
      prices()?metric('Ventes du jour',money(daily),`${sales.filter(d=>d.date?.slice(0,10)===today()).length} documents de vente aujourd’hui`,'cart','green'):metric('Inventaires en cours',num(inProgress),'Sessions de comptage à terminer','clipboard','green'),
      metric('Alertes de stock',num(low.length),low.length?`${icon('alert')} Articles à réapprovisionner`:`${icon('check')} Tous les niveaux sont suffisants`,'alert','orange')
    ];
    const recent=docs().slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5);
    return heading('VOTRE ACTIVITÉ, EN UN COUP D’ŒIL','Vue d’ensemble',`Bienvenue ${esc((user.name || 'à vous').split(' ')[0])}, gardez le contrôle de votre commerce.`,`${storeSelect()}${user.role!=='inventory'?btn('Nouvelle opération','new-document','plus'):btn('Nouvel inventaire','new-inventory','plus')}`)+
    `<div class="metrics">${metrics.join('')}</div><div class="dashboard-grid">
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Activité du commerce</h2><p class="panel-description">Entrées et sorties sur les 7 derniers jours</p></div><span class="badge neutral">7 jours</span></div>${activityChart()}<div class="chart-summary"><div><span>${prices()?'Ventes sur la période':'Quantités sorties'}</span><strong>${prices()?money(periodDocuments(7,'sale').reduce((s,d)=>s+d.total,0)):num(periodDocuments(7,'sale').reduce((s,d)=>s+d.lines.reduce((t,l)=>t+l.quantity,0),0))}</strong></div><div><span>${prices()?'Achats sur la période':'Quantités entrées'}</span><strong>${prices()?money(periodDocuments(7,'purchase').reduce((s,d)=>s+d.total,0)):num(periodDocuments(7,'purchase').reduce((s,d)=>s+d.lines.reduce((t,l)=>t+l.quantity,0),0))}</strong></div></div></section>
      <section class="panel quick-panel"><div class="panel-header"><div><h2 class="panel-title">Aller à l’essentiel</h2><p class="panel-description">Vos actions du quotidien</p></div></div><div class="quick-actions">${user.role!=='inventory'?`<button class="quick-action" data-action="new-sale"><span class="quick-icon green">${icon('cart')}</span><span><strong>Enregistrer une vente</strong><small>Articles, client et paiement</small></span>${icon('chevron')}</button>`:''}${admin()?`<button class="quick-action" data-action="new-purchase"><span class="quick-icon purple">${icon('download')}</span><span><strong>Réceptionner du stock</strong><small>Ajouter une entrée fournisseur</small></span>${icon('chevron')}</button>`:''}${user.role!=='cashier'?`<button class="quick-action" data-action="new-inventory"><span class="quick-icon blue">${icon('clipboard')}</span><span><strong>Démarrer un inventaire</strong><small>Compter et vérifier les écarts</small></span>${icon('chevron')}</button>`:''}${admin()?`<button class="quick-action" data-action="new-product"><span class="quick-icon orange">${icon('box')}</span><span><strong>Ajouter un produit</strong><small>Enrichir votre catalogue</small></span>${icon('chevron')}</button>`:''}</div><div class="quick-note">${icon('wifi')}Consultation et saisies disponibles hors ligne</div></section>
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">À réapprovisionner <span class="count-chip">${low.length}</span></h2><p class="panel-description">Ces articles ont atteint leur seuil minimum</p></div><button class="text-btn" data-action="show-low">Tout voir ${icon('chevron')}</button></div><div class="table-wrapper"><table><thead><tr><th>Produit</th><th>Stock actuel</th><th>Seuil min.</th><th>État</th></tr></thead><tbody>${low.slice(0,4).map(p=>`<tr><td>${productCell(p)}</td><td>${stockCell(p)}</td><td>${num(p.minStock)}</td><td>${stockBadge(p)}</td></tr>`).join('')}</tbody></table>${!low.length?empty('Votre stock est au vert','Aucun article sous son seuil minimum.','check'):''}</div></section>
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">Derniers mouvements</h2><p class="panel-description">L’historique de votre activité</p></div>${user.role!=='inventory'?'<button class="text-btn" data-view="documents">Tout voir</button>':''}</div><div class="activity-list">${recent.map(d=>`<button class="activity-item" data-document="${d.id}"><span class="activity-icon ${typeTone[d.type]}">${icon(d.type==='sale'?'cart':d.type==='purchase'?'download':'arrows')}</span><span class="activity-copy"><strong>${typeNames[d.type]} · ${esc(d.number)}</strong><small>${esc(storeName(d.storeId))} · ${date(d.date || d.createdAt)}</small></span><span class="activity-meta"><strong>${prices()&&['sale','purchase'].includes(d.type)?money(d.total):num(d.lines.reduce((sum,l)=>sum+Math.abs(l.quantity),0))+' unités'}</strong>${d.total>0&&prices()?`<small>${d.paid>=d.total?'Réglé':'Paiement partiel'}</small>`:''}</span></button>`).join('')}${!recent.length?empty('Aucun mouvement','Vos opérations apparaîtront ici.','arrows'):''}</div>${prices()&&receivables?`<div class="receivables-note">${icon('wallet')}<span>Créances clients</span><strong>${money(receivables)}</strong></div>`:''}</section></div>`;
  }
  function periodDocuments(days,type) {
    const start=firstDay(days);
    return docs().filter(d=>d.type===type&&(d.date || d.createdAt).slice(0,10)>=start&&(d.date || d.createdAt).slice(0,10)<=today());
  }
  function activityChart() {
    const values=[];
    for(let offset=6;offset>=0;offset--){
      const day=new Date();day.setUTCDate(day.getUTCDate()-offset);const key=businessDay(day);
      const totals=['sale','purchase'].map(type=>docs().filter(d=>d.type===type&&(d.date || d.createdAt).slice(0,10)===key).reduce((sum,d)=>sum+(prices()?d.total:d.lines.reduce((s,l)=>s+l.quantity,0)),0));
      values.push({label:new Intl.DateTimeFormat('fr-FR',{timeZone:'Africa/Porto-Novo',weekday:'short'}).format(day),totals});
    }
    const max=Math.max(1,...values.flatMap(v=>v.totals));
    return `<div class="chart"><div class="chart-legend"><span><i class="legend-dot sale"></i>Ventes</span><span><i class="legend-dot purchase"></i>Achats</span></div><div class="chart-plot"><div class="chart-axis">${[1,.75,.5,.25,0].map(v=>`<span>${prices()?num(Math.round(max*v/1000))+' k':num(Math.round(max*v))}</span>`).join('')}</div><div class="chart-bars">${values.map(v=>`<div class="chart-column"><div class="bar-pair">${v.totals.map((t,i)=>`<div class="chart-bar ${i?'purchase':'sale'}" style="height:${t?Math.max(3,t/max*100):0}%" title="${v.label} · ${i?'Achats':'Ventes'} : ${prices()?money(t):num(t)}"></div>`).join('')}</div><span class="chart-label">${v.label}</span></div>`).join('')}</div></div></div>`;
  }
  function productsPage() {
    const list=filteredProducts();
    return heading('UN CATALOGUE BIEN ORGANISÉ','Catalogue produits','Retrouvez vos articles, leurs prix et leurs niveaux de stock.',`${btn('Exporter','export-products','download','secondary')}${admin()?btn('Ajouter un produit','new-product'):''}`)+
    `<div class="panel"><div class="toolbar"><div class="search-box">${icon('search')}<input id="product-search" placeholder="Rechercher un nom, une référence, une marque…" value="${esc(search)}" aria-label="Rechercher un produit"></div><select class="select" id="category-filter" aria-label="Catégorie"><option value="">Toutes les catégories</option>${[...new Set(state.products.map(p=>p.category))].sort().map(c=>`<option ${category===c?'selected':''}>${esc(c)}</option>`).join('')}</select>${storeSelect()}<select class="select" id="stock-filter" aria-label="État du stock"><option value="">Tous les états</option><option value="low" ${stockFilter==='low'?'selected':''}>Stock faible</option><option value="out" ${stockFilter==='out'?'selected':''}>Rupture</option><option value="ok" ${stockFilter==='ok'?'selected':''}>En stock</option></select></div><div class="table-wrapper"><table><thead><tr><th>Produit</th><th>Catégorie</th><th>Stock</th>${prices()?'<th>Prix de vente</th>':''}${prices()&&admin()?'<th>Marge unitaire</th>':''}<th>État</th><th></th></tr></thead><tbody>${list.map(p=>`<tr><td>${productCell(p)}</td><td><span>${esc(p.category)}</span><small class="cell-secondary">${esc(p.location||'—')}</small></td><td>${stockCell(p)}</td>${prices()?`<td class="money-cell">${money(p.sellingPrice)}</td>`:''}${prices()&&admin()?`<td>${money(p.sellingPrice-p.purchasePrice)}<small class="cell-secondary">${p.sellingPrice?num((p.sellingPrice-p.purchasePrice)/p.sellingPrice*100):'0'} %</small></td>`:''}<td>${stockBadge(p)}</td><td><button class="icon-btn" data-edit-product="${p.id}" aria-label="${admin()?'Modifier':'Voir'} ${esc(p.name)}">${icon(admin()?'edit':'eye')}</button></td></tr>`).join('')}</tbody></table>${!list.length?empty('Aucun produit trouvé','Essayez une autre recherche ou ajoutez un article.','search'):''}</div><div class="table-footer"><span>${list.length} produit${list.length>1?'s':''} · ${state.products.length} au catalogue</span>${admin()?'<button class="text-btn" data-action="import-products">'+icon('upload')+' Importer un CSV</button>':''}</div></div>`;
  }
  function documentsPage() {
    const list=docs().filter(d=>!documentFilter||d.type===documentFilter).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return heading('CHAQUE OPÉRATION LAISSE UNE TRACE','Mouvements de stock','Ventes, achats, transferts et ajustements dans un seul historique.',`${storeSelect()}${btn('Nouvelle opération','new-document')}`)+
    `<div class="panel"><div class="toolbar"><div class="tabs">${['','sale','purchase','transfer','adjustment'].filter(t=>admin()||!t||t==='sale').map(t=>`<button class="tab ${documentFilter===t?'active':''}" data-action="filter-documents" data-filter="${t}">${t?typeNames[t]+'s':'Tous les mouvements'}</button>`).join('')}</div>${btn('Exporter CSV','export-documents','download','secondary small')}</div><div class="table-wrapper"><table><thead><tr><th>Document</th><th>Opération</th><th>Date</th><th>Magasin / Tiers</th><th>Articles</th>${prices()?'<th>Total</th><th>Paiement</th>':''}<th></th></tr></thead><tbody>${list.map(d=>`<tr><td><strong>${esc(d.number)}</strong></td><td>${badge(typeNames[d.type],typeTone[d.type])}</td><td>${date(d.date||d.createdAt)}</td><td>${esc(storeName(d.storeId))}<small class="cell-secondary">${esc(d.type==='transfer'?storeName(d.toStoreId):contactName(d.contactId))}</small></td><td>${d.lines.length} ligne${d.lines.length>1?'s':''}</td>${prices()?`<td class="money-cell">${['sale','purchase'].includes(d.type)?money(d.total):'—'}</td><td>${['sale','purchase'].includes(d.type)?badge(d.paid>=d.total?'Réglé':d.paid?'Partiel':'Impayé',d.paid>=d.total?'success':'warning'):'—'}</td>`:''}<td><button class="icon-btn" data-document="${d.id}" aria-label="Voir ${esc(d.number)}">${icon('chevron')}</button></td></tr>`).join('')}</tbody></table>${!list.length?empty('Aucune opération pour ce filtre','Enregistrez votre premier mouvement de stock.','arrows'):''}</div><div class="table-footer">${list.length} document${list.length>1?'s':''} enregistré${list.length>1?'s':''}</div></div>`;
  }
  function inventoriesPage() {
    const list=state.inventories.filter(i=>storeId==='all'||i.storeId===storeId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const draft=list.filter(i=>i.status==='draft').length;
    return heading('LE TERRAIN RENCONTRE VOS DONNÉES','Inventaires','Comptez vos produits et identifiez les écarts, rayon par rayon.',`${storeSelect()}${btn('Nouvel inventaire','new-inventory')}`)+
    `<div class="metrics inventory-metrics">${metric('Sessions en cours',draft,'Comptages à terminer','clipboard','purple')}${metric('Sessions validées',list.length-draft,'Stock ajusté et historique conservé','check','green')}${metric('Articles à compter',list.filter(i=>i.status==='draft').reduce((s,i)=>s+i.lines.filter(l=>l.counted===null).length,0),'Saisies manuelles restantes','box','orange')}</div><div class="grid-2">${list.map(i=>{
      const counted=i.lines.filter(l=>l.counted!==null).length;const variances=i.lines.filter(l=>l.counted!==null&&l.counted!==l.theoretical).length;
      return `<section class="panel inventory-card"><div class="panel-header"><span class="inventory-icon">${icon('clipboard')}</span>${badge(i.status==='validated'?'Validé':'En cours',i.status==='validated'?'success':'purple')}</div><div class="panel-body"><h2>${esc(i.name)}</h2><p>${esc(storeName(i.storeId))} · ${date(i.createdAt)}</p><div class="inventory-progress"><span>${counted} / ${i.lines.length} articles comptés</span><strong>${Math.round(counted/Math.max(i.lines.length,1)*100)} %</strong></div><div class="progress"><i style="width:${counted/Math.max(i.lines.length,1)*100}%"></i></div><div class="inventory-card-footer"><span>${variances} écart${variances>1?'s':''} constaté${variances>1?'s':''}</span><button class="btn secondary small" data-inventory="${i.id}">${i.status==='validated'?'Voir le rapport':'Continuer le comptage'}${icon('chevron')}</button></div></div></section>`;
    }).join('')}</div>${!list.length?`<div class="panel">${empty('Votre premier inventaire commence ici','Créez une session par magasin et, si besoin, par catégorie.','clipboard')}</div>`:''}`;
  }
  function contactsPage() {
    const list=state.contacts.filter(c=>admin()||c.type==='customer');
    return heading('VOS RELATIONS COMMERCIALES','Clients & fournisseurs','Coordonnées, documents et soldes de vos partenaires.',(admin()?btn('Ajouter un contact','new-contact'):''))+
    `<div class="panel"><div class="panel-header"><h2 class="panel-title">Carnet d’adresses <span class="count-chip">${list.length}</span></h2></div><div class="table-wrapper"><table><thead><tr><th>Nom</th><th>Type</th><th>Téléphone</th><th>IFU / NIF</th>${prices()?'<th>Solde à régler</th>':''}<th></th></tr></thead><tbody>${list.map(c=>{
      const balance=state.documents.filter(d=>d.contactId===c.id&&['sale','purchase'].includes(d.type)).reduce((s,d)=>s+d.total-d.paid,0);
      return `<tr><td><div class="product-cell"><span class="contact-avatar">${esc(c.name.slice(0,2).toUpperCase())}</span><div><strong>${esc(c.name)}</strong><small class="cell-secondary">${esc(c.address||'Adresse non renseignée')}</small></div></div></td><td>${badge(c.type==='customer'?'Client':'Fournisseur',c.type==='customer'?'purple':'neutral')}</td><td>${esc(c.phone||'—')}</td><td>${esc(c.taxId||'—')}</td>${prices()?`<td class="${balance?'balance-due':''}">${money(balance)}</td>`:''}<td><button class="icon-btn" data-contact="${c.id}" aria-label="Voir ${esc(c.name)}">${icon('chevron')}</button></td></tr>`;
    }).join('')}</tbody></table>${!list.length?empty('Votre carnet est vide','Ajoutez un client ou un fournisseur.','users'):''}</div></div>`;
  }
  function reportDocuments() {
    const days={day:1,week:7,month:30,all:36500}[reportPeriod];
    const start=firstDay(days);
    return docs().filter(d=>(d.date||d.createdAt).slice(0,10)>=start&&(d.date||d.createdAt).slice(0,10)<=today());
  }
  function reportsPage() {
    const list=reportDocuments(), sales=list.filter(d=>d.type==='sale'), revenue=sales.reduce((s,d)=>s+d.total,0);
    const gross=sales.reduce((s,d)=>s+d.lines.reduce((t,l)=>t+Math.round(l.unitPrice*l.quantity)-Math.round((l.purchaseCost||0)*l.quantity),0),0);
    const days={day:1,week:7,month:30,all:36500}[reportPeriod];const start=firstDay(days);
    const expenses=state.expenses.filter(e=>(storeId==='all'||e.storeId===storeId)&&e.date>=start&&e.date<=today());
    const expenseTotal=expenses.reduce((s,e)=>s+e.amount,0);
    const low=state.products.filter(p=>qty(p.id)<=p.minStock);
    return heading('DES CHIFFRES POUR MIEUX DÉCIDER','Rapports & analyses','Suivez vos ventes, vos marges et vos besoins de réapprovisionnement.',`${storeSelect()}<select class="select" id="report-period" aria-label="Période">${[['day','Aujourd’hui'],['week','7 derniers jours'],['month','30 derniers jours'],['all','Toute la période']].map(([v,l])=>`<option value="${v}" ${v===reportPeriod?'selected':''}>${l}</option>`).join('')}</select>${btn('Exporter','export-report','download','secondary')}`)+
    `${prices()?`<div class="metrics">${metric('Chiffre d’affaires',money(revenue),sales.length+' documents de vente','cart','purple')}${metric('Bénéfice brut réalisé',money(gross),'Coûts d’achat enregistrés lors des ventes','trend','green')}${metric('Frais généraux',money(expenseTotal),expenses.length+' dépenses enregistrées','wallet','orange')}${metric('Résultat net estimé',money(gross-expenseTotal),'Bénéfice brut moins frais saisis, hors taxes','chart','blue')}</div>`:''}<div class="dashboard-grid"><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Rapport de réapprovisionnement</h2><p class="panel-description">Quantité suggérée : retour au double du seuil minimum</p></div>${btn('CSV','export-reorder','download','secondary small')}</div><div class="table-wrapper"><table><thead><tr><th>Produit</th><th>Disponible</th><th>Seuil</th><th>À commander</th></tr></thead><tbody>${low.map(p=>`<tr><td>${productCell(p)}</td><td>${num(qty(p.id))}</td><td>${num(p.minStock)}</td><td><strong>${num(Math.max(0,p.minStock*2-qty(p.id)))}</strong> ${esc(p.unit)}</td></tr>`).join('')}</tbody></table>${!low.length?empty('Aucun besoin urgent','Tous les articles dépassent leur seuil minimum.','check'):''}</div></section><section class="panel"><div class="panel-header"><div><h2 class="panel-title">Frais généraux</h2><p class="panel-description">Dépenses sur la période sélectionnée</p></div>${prices()?btn('Ajouter','new-expense','plus','secondary small'):''}</div>${prices()?`<div class="activity-list">${expenses.map(e=>`<div class="activity-item"><span class="activity-icon neutral">${icon('wallet')}</span><div class="activity-copy"><strong>${esc(e.category)}</strong><small>${date(e.date)} · ${esc(e.note||storeName(e.storeId))}</small></div><strong>${money(e.amount)}</strong></div>`).join('')}${!expenses.length?empty('Aucune dépense saisie','Loyer, salaires, transport… complétez votre résultat.','wallet'):''}</div>`:'<div class="panel-body">Activez les prix dans les paramètres pour saisir les frais.</div>'}</section></div><div class="callout report-callout">${icon('alert')}Les résultats sont des estimations hors taxes, fondées sur les documents et dépenses saisis. La valeur du stock au prix de vente n’est pas un bénéfice réalisé.</div>`;
  }
  function settingsPage() {
    return heading('UN ESPACE À VOTRE MESURE','Paramètres','Personnalisez votre commerce et consultez les capacités de cette version.')+
    `<div class="grid-2"><section class="panel"><div class="panel-header"><h2 class="panel-title">Préférences du commerce</h2></div><div class="panel-body"><form id="settings-form"><div class="field"><label for="business-name">Nom du commerce</label><input class="input" id="business-name" name="businessName" maxlength="100" value="${esc(state.settings.businessName)}" required></div><div class="settings-row"><div><strong>Mode sans prix</strong><p>Conservez les quantités, masquez les données financières.</p></div><label class="switch"><input type="checkbox" name="noPrices" ${state.settings.noPrices?'checked':''} aria-label="Mode sans prix"><span></span></label></div><div class="settings-row"><div><strong>Devise</strong><p>Franc CFA BCEAO (XOF) · Montants entiers</p></div><span class="badge neutral">XOF</span></div><button class="btn primary" type="submit">${icon('check')}Enregistrer les préférences</button></form></div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">Magasins & accès</h2></div><div class="panel-body">${state.stores.map(s=>`<div class="settings-row"><span class="store-line">${icon('store')}<strong>${esc(s.name)}</strong></span><span>${esc(s.city||'')}</span></div>`).join('')}<p class="field-hint">Les données sont séparées par magasin. Les rôles sont contrôlés côté serveur : administrateur, caissier et agent d’inventaire.</p></div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">Données & sauvegarde</h2></div><div class="panel-body"><p>Exportez un instantané JSON de vos données métier. Ce fichier ne contient ni comptes, ni fichiers image ; il ne remplace pas une sauvegarde complète de la base.</p><div class="heading-actions">${btn('Exporter les données','backup','download','secondary')}${btn('Importer le catalogue','import-products','upload','secondary')}</div><p class="field-hint">Pour une sauvegarde complète : base SQLite et dossier uploads. L’automatisation cloud reste à déployer.</p></div></section><section class="panel"><div class="panel-header"><h2 class="panel-title">Hors ligne & synchronisation</h2></div><div class="panel-body"><p>Votre dernier état est conservé sur cet appareil. Les saisies hors ligne sont mises en attente, puis validées par le serveur à la reconnexion.</p><div class="settings-row"><strong>Saisies en attente</strong><span class="badge ${pending.length?'warning':'success'}">${pending.length}</span></div>${btn('Voir la file d’attente','sync','refresh','secondary')}<p class="field-hint">Cette version synchronise avec le serveur local. La connexion à un hébergement cloud sera ajoutée à l’étape suivante. Évitez les appareils partagés pour les données sensibles hors ligne.</p></div></section></div>`;
  }
  function modal(title,body,footer='',wide=false) {
    modalRoot.innerHTML=`<div class="dialog-backdrop"><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-header"><div><h2 id="dialog-title">${title}</h2></div><button class="icon-btn" data-close aria-label="Fermer">${icon('close')}</button></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-footer">${footer}</div>`:''}</section></div>`;
    document.body.classList.add('modal-open');
    $$('[data-close]',modalRoot).forEach(el=>el.addEventListener('click',closeModal));
    $('.dialog-backdrop',modalRoot).addEventListener('click',e=>{if(e.target.classList.contains('dialog-backdrop'))closeModal();});
    setTimeout(()=>$('.dialog input, .dialog select, .dialog button')?.focus(),0);
  }
  function closeModal() {modalRoot.innerHTML='';document.body.classList.remove('modal-open');}
  function field(label,name,value='',options={}) {
    return `<div class="field ${options.full?'full':''}"><label for="field-${name}">${label}${options.required?' <span class="required">*</span>':''}</label>${options.options?`<select class="input" id="field-${name}" name="${name}" ${options.required?'required':''}>${options.options.map(([v,l])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''}>${esc(l)}</option>`).join('')}</select>`:options.area?`<textarea class="input" id="field-${name}" name="${name}" rows="3" maxlength="1000">${esc(value)}</textarea>`:`<input class="input" id="field-${name}" name="${name}" type="${options.type||'text'}" value="${esc(value)}" ${options.required?'required':''} ${options.min!==undefined?`min="${options.min}"`:''} ${options.step?`step="${options.step}"`:''} ${options.max!==undefined?`max="${options.max}"`:''} ${options.placeholder?`placeholder="${esc(options.placeholder)}"`:''} ${options.readonly?'readonly':''}>`}${options.hint?`<small class="field-hint">${options.hint}</small>`:''}</div>`;
  }
  function formModal(title,body,onSubmit,wide=false,submitLabel='Enregistrer') {
    modal(title,`<form id="dialog-form"><div class="form-grid">${body}</div><div class="form-error" role="alert"></div><div class="dialog-footer"><button type="button" class="btn secondary" data-close>Annuler</button><button type="submit" class="btn primary">${icon('check')}${submitLabel}</button></div></form>`,'',wide);
    $('#dialog-form').addEventListener('submit',async event=>{
      event.preventDefault();const form=event.currentTarget;const button=$('[type=submit]',form);
      button.disabled=true;$('.form-error',form).textContent='';
      try {await onSubmit(new FormData(form),form);closeModal();}
      catch(error){$('.form-error',form).textContent=error.message;button.disabled=false;}
    });
  }
  function productForm(id) {
    const p=id?product(id):{name:'',sku:'',category:'',unit:'pièce',purchasePrice:0,sellingPrice:0,minStock:5,brand:'',location:'',notes:'',tags:[],color:'#ece8ff',photo:''};
    if (!admin()) {
      modal(esc(p.name),`<div class="product-detail">${productCell(p)}<div class="form-grid">${field('Référence','sku',p.sku,{readonly:true})}${field('Catégorie','category',p.category,{readonly:true})}${field('Marque','brand',p.brand,{readonly:true})}${field('Emplacement','location',p.location,{readonly:true})}${field('Quantité disponible','stock',num(qty(p.id)),{readonly:true})}${prices()?field('Prix de vente','price',money(p.sellingPrice),{readonly:true}):''}</div><p>${esc(p.notes)}</p></div>`);
      return;
    }
    const fields=field('Nom du produit','name',p.name,{required:true})+field('Référence / SKU','sku',p.sku,{required:true})+field('Catégorie / dossier','category',p.category,{required:true,placeholder:'Épicerie / Céréales'})+field('Unité','unit',p.unit,{options:[...new Set(['pièce','kg','litre','carton','sachet','bouteille','paquet','sac','boîte','pot','brique',p.unit])].map(v=>[v,v])})+field('Marque','brand',p.brand)+field('Emplacement','location',p.location)+
      (prices()?field('Prix d’achat (FCFA)','purchasePrice',p.purchasePrice,{type:'number',min:0,step:1,required:true})+field('Prix de vente (FCFA)','sellingPrice',p.sellingPrice,{type:'number',min:0,step:1,required:true}):'')+field('Seuil minimum','minStock',p.minStock,{type:'number',min:0,step:'0.001',required:true})+field('Tags (séparés par des virgules)','tags',p.tags.join(', '))+`<div class="field full"><label for="product-photo">Photo du produit</label><input class="input" id="product-photo" type="file" name="photoFile" accept="image/png,image/jpeg,image/webp"><small class="field-hint">PNG, JPEG ou WebP · 5 Mo maximum · Connexion requise pour l’envoi.</small>${p.photo?`<img class="photo-preview" src="${esc(p.photo)}" alt="Photo actuelle">`:''}</div>`+field('Notes','notes',p.notes,{area:true,full:true})+(!id?'<div class="callout full">Le stock initial est à zéro. Enregistrez ensuite un achat ou un ajustement pour ajouter des quantités.</div>':'');
    formModal(id?'Modifier le produit':'Ajouter un produit',fields,async data=>{
      let photo=p.photo;
      const file=data.get('photoFile');
      if(file?.size){
        if(!navigator.onLine)throw new Error('L’envoi de photo nécessite une connexion.');
        const body=new FormData();body.append('images',file);
        const response=await fetch('/upload',{method:'POST',body});const result=await response.json();
        if(!response.ok)throw new Error(result.error||'Envoi de la photo impossible.');
        photo=result[0];
      }
      await perform('product.save',{...p,...Object.fromEntries(data),id:id||undefined,purchasePrice:prices()?Number(data.get('purchasePrice')):p.purchasePrice,sellingPrice:prices()?Number(data.get('sellingPrice')):p.sellingPrice,minStock:Number(data.get('minStock')),tags:String(data.get('tags')).split(',').map(t=>t.trim()).filter(Boolean),photo,expectedVersion:p.version},'Produit '+(id?'modifié':'ajouté')+' avec succès.');
    },true);
  }
  function contactForm(existing) {
    const c=existing||{type:'customer',name:'',phone:'',address:'',taxId:''};
    formModal(existing?'Modifier le contact':'Ajouter un contact',field('Nom / Raison sociale','name',c.name,{required:true})+field('Type','type',c.type,{options:admin()?[['customer','Client'],['supplier','Fournisseur']]:[['customer','Client']]})+field('Téléphone','phone',c.phone)+field('IFU / NIF','taxId',c.taxId)+field('Adresse','address',c.address,{full:true}),async data=>{await perform('contact.save',{...c,...Object.fromEntries(data)},'Contact enregistré.');});
  }
  function contactDetail(id) {
    const c=state.contacts.find(c=>c.id===id);const list=state.documents.filter(d=>d.contactId===id);
    modal(esc(c.name),`<p>${esc(c.phone)} · ${esc(c.address)}</p><p class="field-hint">IFU / NIF : ${esc(c.taxId||'Non renseigné')}</p>${prices()?`<div class="contact-balance"><span>${c.type==='customer'?'Créance client':'Dette fournisseur'}</span><strong>${money(list.reduce((s,d)=>s+d.total-d.paid,0))}</strong></div>`:''}<div class="table-wrapper"><table><thead><tr><th>Document</th><th>Date</th>${prices()?'<th>Total</th><th>Restant</th>':''}<th></th></tr></thead><tbody>${list.map(d=>`<tr><td>${esc(d.number)}</td><td>${date(d.date)}</td>${prices()?`<td>${money(d.total)}</td><td>${money(d.total-d.paid)}</td>`:''}<td><button class="icon-btn" data-contact-document="${d.id}" aria-label="Voir le document">${icon('chevron')}</button></td></tr>`).join('')}</tbody></table>${!list.length?empty('Aucun document','Les achats ou ventes associés apparaîtront ici.','arrows'):''}</div>`,admin()?btn('Modifier le contact','edit-contact','edit','secondary'):'',true);
    $$('[data-contact-document]').forEach(el=>el.addEventListener('click',()=>receipt(el.dataset.contactDocument)));
    $('[data-action="edit-contact"]',modalRoot)?.addEventListener('click',()=>contactForm(c));
  }
  function documentForm(initialType='sale') {
    if (!state.products.length) {toast('Ajoutez d’abord un produit au catalogue.',true);return;}
    const types=admin()?Object.entries(typeNames):[['sale','Vente']];
    const activeStore=storeId==='all'?state.stores[0].id:storeId;
    const fields=field('Opération','type',initialType,{options:types})+field('Magasin source','storeId',activeStore,{options:state.stores.map(s=>[s.id,s.name])})+`<div id="destination-field" class="field" hidden><label for="transfer-destination">Magasin destination</label><select class="input" id="transfer-destination" name="toStoreId">${state.stores.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>`+field('Date du document','date',today(),{type:'date',required:true})+`<div id="contact-field" class="field"><label for="document-contact">Client / Fournisseur</label><select class="input" id="document-contact" name="contactId"></select></div><div class="field full"><label>Articles</label><div id="document-lines"></div><button type="button" class="text-btn" id="add-line">${icon('plus')}Ajouter une ligne</button><small id="adjustment-hint" class="field-hint" hidden>Quantité positive : ajout. Quantité négative : perte, casse ou retrait.</small></div><div class="document-summary full"><span>Total du document</span><strong id="document-total">0 FCFA</strong></div>`+`<div id="paid-field" class="field">${field('Montant payé (FCFA)','paid',0,{type:'number',min:0,step:1})}</div>`+field('Note / motif','note','',{area:true,full:true});
    formModal('Nouvelle opération',fields,async(data,form)=>{
      const type=data.get('type');
      const lines=$$('.document-line',form).map(row=>({productId:$('[name=lineProduct]',row).value,quantity:Number($('[name=lineQuantity]',row).value),unitPrice:prices()?Number($('[name=linePrice]',row)?.value || 0):(type==='purchase'?product($('[name=lineProduct]',row).value).purchasePrice:product($('[name=lineProduct]',row).value).sellingPrice)||0}));
      if(!lines.length)throw new Error('Ajoutez au moins un article.');
      if(new Set(lines.map(l=>l.productId)).size!==lines.length)throw new Error('Regroupez les quantités d’un même produit sur une seule ligne.');
      await perform('document.create',{type,storeId:data.get('storeId'),toStoreId:type==='transfer'?data.get('toStoreId'):undefined,contactId:['sale','purchase'].includes(type)?data.get('contactId')||undefined:undefined,lines,paid:['sale','purchase'].includes(type)?(prices()?Number(data.get('paid')||0):lines.reduce((sum,line)=>sum+Math.round(line.quantity*line.unitPrice),0)):0,note:data.get('note'),date:data.get('date')},'Opération enregistrée.');
    },true,'Valider l’opération');
    let counter=0;
    const currentType=()=>$('[name=type]',modalRoot).value;
    const recalc=()=> {
      const financial=prices()&&['sale','purchase'].includes(currentType());
      const total=financial?$$('.document-line',modalRoot).reduce((s,row)=>s+Math.round(Number($('[name=lineQuantity]',row).value||0)*Number($('[name=linePrice]',row)?.value||0)),0):0;
      $('#document-total').textContent=money(Math.round(total));const paid=$('#field-paid');paid.max=Math.round(total);if(!paid.dataset.manual)paid.value=Math.round(total);
    };
    const addLine=()=>{
      const id=counter++;
      const row=document.createElement('div');row.className='document-line';
      row.innerHTML=`<div class="line-product"><input class="input line-search" placeholder="Filtrer par nom ou référence…" aria-label="Rechercher un article ligne ${id+1}"><select class="input" name="lineProduct" aria-label="Article ligne ${id+1}">${state.products.map(p=>`<option value="${p.id}">${esc(p.name)} — ${esc(p.sku)}</option>`).join('')}</select><small class="line-stock field-hint"></small></div><div class="field"><label>Quantité</label><input class="input" type="number" name="lineQuantity" step="0.001" min="${currentType()==='adjustment'?'-1000000':'0.001'}" value="1" required aria-label="Quantité ligne ${id+1}"></div>${prices()?`<div class="field line-price-field"><label>Prix unitaire</label><input class="input" type="number" name="linePrice" min="0" step="1" value="0" required aria-label="Prix unitaire ligne ${id+1}"></div>`:''}<button type="button" class="icon-btn remove-line" aria-label="Supprimer la ligne ${id+1}">${icon('close')}</button>`;
      $('#document-lines').append(row);
      const setPrice=()=>{const p=product($('[name=lineProduct]',row).value);const input=$('[name=linePrice]',row);if(input)input.value=currentType()==='purchase'?p.purchasePrice||0:p.sellingPrice||0;$('.line-stock',row).textContent=`Disponible : ${num(qty(p.id,$('[name=storeId]',modalRoot).value))} ${p.unit}`;recalc();};
      $('[name=lineProduct]',row).addEventListener('change',setPrice);
      $('.line-search',row).addEventListener('input',e=>{
        const select=$('[name=lineProduct]',row);const current=select.value;
        const list=state.products.filter(p=>normalize(p.name+' '+p.sku).includes(normalize(e.target.value)));
        select.innerHTML=list.map(p=>`<option value="${p.id}">${esc(p.name)} — ${esc(p.sku)}</option>`).join('');
        if(list.some(p=>p.id===current))select.value=current;
        setPrice();
      });
      $('.remove-line',row).addEventListener('click',()=>{row.remove();recalc();});
      $$('input[type=number]',row).forEach(input=>input.addEventListener('input',recalc));
      setPrice();toggle();
    };
    const toggle=()=>{
      const type=currentType(), financial=prices()&&['sale','purchase'].includes(type);
      $('#destination-field').hidden=type!=='transfer';$('#contact-field').hidden=!['sale','purchase'].includes(type);
      $('#paid-field').hidden=!financial;$('.document-summary').hidden=!financial;$('#adjustment-hint').hidden=type!=='adjustment';
      $('#field-paid').disabled=!financial;
      const select=$('#document-contact');select.innerHTML='<option value="">'+(type==='purchase'?'Sans fournisseur':'Client comptoir')+'</option>'+state.contacts.filter(c=>c.type===(type==='purchase'?'supplier':'customer')).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
      $$('.document-line',modalRoot).forEach(row=>{const q=$('[name=lineQuantity]',row);q.min=type==='adjustment'?'-1000000':'0.001';const p=product($('[name=lineProduct]',row).value);const input=$('[name=linePrice]',row);if(input){input.value=type==='purchase'?p.purchasePrice||0:p.sellingPrice||0;input.disabled=!financial;}$('.line-price-field',row)?.toggleAttribute('hidden',!financial);});
      recalc();
    };
    $('[name=type]',modalRoot).addEventListener('change',toggle);
    $('[name=storeId]',modalRoot).addEventListener('change',()=>{$$('.document-line',modalRoot).forEach(row=>$('.line-stock',row).textContent='Disponible : '+num(qty($('[name=lineProduct]',row).value,$('[name=storeId]',modalRoot).value)));});
    $('#field-paid').addEventListener('input',e=>e.target.dataset.manual='yes');$('#transfer-destination').value=state.stores.find(s=>s.id!==activeStore)?.id||activeStore;$('#add-line').addEventListener('click',addLine);addLine();
  }
  function receipt(id) {
    const d=state.documents.find(d=>d.id===id);if(!d)return;
    modal(`${typeNames[d.type]} · ${esc(d.number)}`,`<article class="print-document"><div class="receipt-header"><div><h2>${esc(state.settings.businessName)}</h2><p>${esc(storeName(d.storeId))}${d.toStoreId?' → '+esc(storeName(d.toStoreId)):''}</p></div><div><strong>${esc(d.number)}</strong><p>${date(d.date||d.createdAt)}</p></div></div><div class="receipt-party"><span>${d.type==='purchase'?'Fournisseur':'Client'}</span><strong>${esc(contactName(d.contactId))}</strong></div><div class="table-wrapper"><table><thead><tr><th>Article</th><th>Quantité</th>${prices()&&['sale','purchase'].includes(d.type)?'<th>Prix unitaire</th><th>Total</th>':''}</tr></thead><tbody>${d.lines.map(l=>`<tr><td>${esc(l.name||product(l.productId).name)}<small class="cell-secondary">${esc(l.sku||product(l.productId).sku)}</small></td><td>${num(l.quantity)} ${esc(l.unit||product(l.productId).unit)}</td>${prices()&&['sale','purchase'].includes(d.type)?`<td>${money(l.unitPrice)}</td><td>${money(Math.round(l.quantity*l.unitPrice))}</td>`:''}</tr>`).join('')}</tbody></table></div>${prices()&&['sale','purchase'].includes(d.type)?`<div class="receipt-totals"><p><span>Total</span><strong>${money(d.total)}</strong></p><p><span>Payé</span><strong>${money(d.paid)}</strong></p><p class="balance"><span>Solde restant</span><strong>${money(d.total-d.paid)}</strong></p></div>`:''}${d.note?`<p class="receipt-note">Note : ${esc(d.note)}</p>`:''}<p class="field-hint">Document interne · Montants hors taxes · Ne constitue pas une facture fiscale certifiée.</p></article>`,`${btn('Imprimer / PDF','print','print','secondary')}${prices()&&d.total>d.paid&&['sale','purchase'].includes(d.type)?btn('Ajouter un paiement','payment','wallet'):''}`,true);
    $('[data-action=print]',modalRoot)?.addEventListener('click',()=>window.print());
    $('[data-action=payment]',modalRoot)?.addEventListener('click',()=>paymentForm(d));
  }
  function paymentForm(d) {
    formModal('Enregistrer un paiement',`<div class="callout full">${esc(d.number)} · Restant à régler : ${money(d.total-d.paid)}</div>`+field('Montant (FCFA)','amount',d.total-d.paid,{type:'number',min:1,max:d.total-d.paid,step:1,required:true})+field('Date','date',today(),{type:'date',required:true}),async data=>{await perform('payment.create',{documentId:d.id,amount:Number(data.get('amount')),date:data.get('date')},'Paiement enregistré.');});
  }
  function inventoryForm() {
    formModal('Démarrer un inventaire',field('Nom de la session','name','Inventaire du '+date(new Date()),{required:true,full:true})+field('Magasin','storeId',storeId==='all'?state.stores[0].id:storeId,{options:state.stores.map(s=>[s.id,s.name])})+field('Catégorie','category','',{options:[['','Toutes les catégories'],...[...new Set(state.products.map(p=>p.category))].map(c=>[c,c])]})+'<div class="callout full">Le stock théorique est figé à la création. Si un mouvement intervient pendant le comptage, la validation signalera le conflit.</div>',async data=>{await perform('inventory.create',Object.fromEntries(data),'Session d’inventaire créée.');});
  }
  function inventoryDetail(id) {
    const inv=state.inventories.find(i=>i.id===id);if(!inv)return;
    const readOnly=inv.status==='validated';
    modal(esc(inv.name),`<p class="subtitle">${esc(storeName(inv.storeId))} · ${date(inv.createdAt)} · ${readOnly?'Rapport validé':'Saisie des quantités constatées'}</p><form id="count-form"><div class="table-wrapper"><table><thead><tr><th>Produit</th><th>Théorique</th><th>Compté</th><th>Écart</th></tr></thead><tbody>${inv.lines.map(l=>`<tr class="inventory-line" data-product-id="${l.productId}"><td>${productCell(product(l.productId))}</td><td>${num(l.theoretical)}</td><td>${readOnly?num(l.counted):`<input type="number" class="input count-input" step="0.001" min="0" value="${l.counted===null?'':l.counted}" placeholder="—" aria-label="Quantité comptée ${esc(product(l.productId).name)}">`}</td><td class="count-variance">${l.counted===null?'—':varianceBadge(l.counted-l.theoretical)}</td></tr>`).join('')}</tbody></table></div><div class="form-error" role="alert"></div><div class="dialog-footer">${btn('Exporter les écarts','export-variance','download','secondary')}${!readOnly?'<button type="submit" class="btn secondary">'+icon('check')+'Enregistrer le comptage</button>':''}${!readOnly&&admin()?btn('Valider l’inventaire','validate-inventory','clipboard'):''}</div></form>`,'',true);
    $$('input.count-input',modalRoot).forEach(input=>input.addEventListener('input',()=>{const row=input.closest('tr');const line=inv.lines.find(l=>l.productId===row.dataset.productId);$('.count-variance',row).innerHTML=input.value===''?'—':varianceBadge(Number(input.value)-line.theoretical);}));
    const counts=()=>$$('.inventory-line',modalRoot).filter(row=>$('input',row)?.value!=='').map(row=>({productId:row.dataset.productId,quantity:Number($('input',row).value)}));
    $('#count-form').addEventListener('submit',async e=>{
      e.preventDefault();if(readOnly)return;
      try{await perform('inventory.count',{inventoryId:id,counts:counts()},'Comptage enregistré.');closeModal();}
      catch(error){$('.form-error',modalRoot).textContent=error.message;}
    });
    $('[data-action=validate-inventory]',modalRoot)?.addEventListener('click',async e=>{
      e.currentTarget.disabled=true;
      try{
        if(!navigator.onLine)throw new Error('Reconnectez-vous pour valider et ajuster les stocks.');
        const allCounts=counts();
        if(allCounts.length!==inv.lines.length)throw new Error('Comptez tous les articles avant de valider.');
        const countResult=await command('inventory.count',{inventoryId:id,counts:allCounts});
        if(countResult.queued){toast('Comptage en attente. Reconnectez-vous avant de valider.');closeModal();return;}
        await perform('inventory.validate',{inventoryId:id},'Inventaire validé. Les écarts ont ajusté les stocks.');closeModal();
      }catch(error){$('.form-error',modalRoot).textContent=error.message;e.currentTarget.disabled=false;}
    });
    $('[data-action=export-variance]',modalRoot).addEventListener('click',()=>exportCSV('ecarts-inventaire',['SKU','Produit','Théorique','Compté','Écart'],inv.lines.map(l=>[product(l.productId).sku,product(l.productId).name,l.theoretical,l.counted??'',l.counted===null?'':l.counted-l.theoretical])));
  }
  const varianceBadge = delta => badge((delta>0?'+':'')+num(delta),delta===0?'success':delta<0?'danger':'purple');
  function expenseForm() {
    formModal('Ajouter une dépense',field('Catégorie','category','Loyer',{options:['Loyer','Salaires','Électricité','Transport','Entretien','Autres'].map(v=>[v,v])})+field('Magasin','storeId',storeId==='all'?state.stores[0].id:storeId,{options:state.stores.map(s=>[s.id,s.name])})+field('Montant (FCFA)','amount','',{type:'number',min:1,step:1,required:true})+field('Date','date',today(),{type:'date',required:true})+field('Note','note','',{area:true,full:true}),async data=>{await perform('expense.create',{...Object.fromEntries(data),amount:Number(data.get('amount'))},'Dépense enregistrée.');});
  }
  function download(name,content,type='text/csv;charset=utf-8') {
    const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  function exportCSV(name,headers,rows) {
    const cell=value=>{let v=String(value??'');if(/^[=+\-@\t\r]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';};
    download(`${name}-${today()}.csv`,'\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(';')).join('\r\n'));toast('Export CSV téléchargé.');
  }
  function exportProducts() {
    const headers=['Nom','SKU','Catégorie','Unité','Marque','Emplacement','Seuil minimum','Stock',...(prices()?['Prix vente']:[]),...(prices()&&admin()?['Prix achat']:[]),'Tags'];
    exportCSV('catalogue',headers,filteredProducts().map(p=>[p.name,p.sku,p.category,p.unit,p.brand,p.location,p.minStock,qty(p.id),...(prices()?[p.sellingPrice]:[]),...(prices()&&admin()?[p.purchasePrice]:[]),p.tags.join(',')]));
  }
  function exportDocuments(list=docs()) {
    exportCSV('mouvements',['Numéro','Type','Date','Magasin','Utilisateur','SKU','Produit','Quantité',...(prices()?['Prix unitaire','Total document','Payé','Restant']:[])],list.flatMap(d=>d.lines.map(l=>[d.number,typeNames[d.type],d.date,storeName(d.storeId),d.createdBy,product(l.productId).sku,product(l.productId).name,l.quantity,...(prices()?[l.unitPrice,d.total,d.paid,d.total-d.paid]:[])])));
  }
  function parseCSV(text) {
    text=text.replace(/^\uFEFF/,'');
    const firstLine=text.slice(0,text.indexOf('\n')<0?text.length:text.indexOf('\n'));
    const delimiter=firstLine.includes(';')?';':',';
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
      else if(c===delimiter&&!quoted){row.push(cell);cell='';}
      else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';}
      else cell+=c;
    }
    if(quoted)throw new Error('Le fichier contient une cellule entre guillemets non fermée.');
    if(cell||row.length){row.push(cell);rows.push(row);}
    return rows;
  }
  function importProducts() {
    formModal('Importer le catalogue CSV',`<div class="callout full">Les colonnes requises sont <strong>Nom</strong> et <strong>SKU</strong>. Colonnes optionnelles : Catégorie, Unité, Marque, Emplacement, Seuil minimum, Prix achat, Prix vente, Tags. Le stock se renseigne par un mouvement, pas par cet import.</div><div class="field full"><label for="csv-file">Fichier CSV UTF-8</label><input class="input" type="file" name="csvFile" id="csv-file" accept=".csv,text/csv" required></div><div class="field full"><p class="field-hint">Maximum 500 articles. Les SKU existants seront mis à jour. Chaque ligne est validée individuellement ; le bilan signale les lignes rejetées.</p></div>`,async(data)=>{
      if(!navigator.onLine)throw new Error('L’import groupé nécessite une connexion.');
      const file=data.get('csvFile');if(file.size>2*1024*1024)throw new Error('Le fichier dépasse 2 Mo.');
      const rows=parseCSV(await file.text());const headers=rows.shift()?.map(normalize)||[];
      const find=(row,name)=>{const i=headers.indexOf(normalize(name));return i<0?'':row[i]?.trim()||'';};
      if(!headers.includes('nom')||!headers.includes('sku'))throw new Error('Colonnes Nom et SKU introuvables.');
      if(rows.length>500)throw new Error('Limitez cet import à 500 articles.');
      const errors=[];let done=0;
      for(let i=0;i<rows.length;i++){
        const row=rows[i],sku=find(row,'SKU');
        const p=state.products.find(p=>normalize(p.sku)===normalize(sku));
        try{
          await command('product.save',{...p,id:p?.id,name:find(row,'Nom'),sku,category:find(row,'Catégorie')||p?.category||'Sans catégorie',unit:find(row,'Unité')||p?.unit||'pièce',brand:find(row,'Marque')||p?.brand||'',location:find(row,'Emplacement')||p?.location||'',minStock:Number(find(row,'Seuil minimum')||p?.minStock||0),purchasePrice:Number(find(row,'Prix achat')||p?.purchasePrice||0),sellingPrice:Number(find(row,'Prix vente')||p?.sellingPrice||0),tags:(find(row,'Tags')||p?.tags?.join(',')||'').split(',').filter(Boolean),expectedVersion:p?.version,color:p?.color||'#ece8ff',notes:p?.notes||'',photo:p?.photo||''});
          done++;
        }catch(error){errors.push(`Ligne ${i+2} (${sku}) : ${error.message}`);}
      }
      if(errors.length){modal('Bilan de l’import',`<p>${done} article(s) importé(s), ${errors.length} ligne(s) rejetée(s).</p><ul>${errors.map(e=>'<li>'+esc(e)+'</li>').join('')}</ul>`);throw new Error('');}
      toast(`${done} article(s) importé(s).`);
    },true,'Importer');
  }
  function pendingDialog() {
    modal('Saisies en attente',`<p class="subtitle">Les stocks affichés correspondent au dernier état confirmé. Ces saisies seront validées par le serveur, sans double enregistrement.</p>${pending.length?`<div class="pending-list">${pending.map(item=>`<div class="pending-item"><div><strong>${esc({'document.create':'Mouvement de stock','product.save':'Produit','inventory.count':'Comptage','inventory.create':'Session d’inventaire','contact.save':'Contact','payment.create':'Paiement','expense.create':'Dépense','settings.update':'Préférences'}[item.type]||item.type)}</strong><small>${date(new Date(item.queuedAt))}</small>${item.error?`<p class="form-error">${esc(item.error)}</p>`:'<p class="field-hint">En attente de connexion ou d’envoi.</p>'}</div><button class="btn ${item.error?'danger':'secondary'} small" data-discard="${item.id}">Abandonner</button></div>`).join('')}</div>`:empty('Toutes vos saisies sont synchronisées','Aucune opération en attente sur cet appareil.','check')}`,btn('Synchroniser maintenant','sync-now','refresh','primary'),true);
    $$('[data-discard]',modalRoot).forEach(el=>el.addEventListener('click',()=>{
      modal('Abandonner cette saisie ?',`<p>Cette opération n’a pas été confirmée localement. Un envoi interrompu peut avoir été accepté par le serveur : synchronisez d’abord pour vérifier. L’abandon retire uniquement la copie locale.</p>`,btn('Confirmer l’abandon','confirm-discard','close','danger')+'<button class="btn secondary" data-close>Annuler</button>');
      $('[data-action=confirm-discard]').addEventListener('click',async()=>{await local.removeCommand(el.dataset.discard);pending=await local.pending(user.id);render();pendingDialog();});
    }));
    $('[data-action=sync-now]',modalRoot)?.addEventListener('click',async()=>{await sync();pendingDialog();});
  }
  async function action(name,data={}) {
    switch(name){
      case 'menu':document.body.classList.toggle('nav-open');break;
      case 'close-nav':document.body.classList.remove('nav-open');break;
      case 'new-product':productForm();break;
      case 'new-contact':contactForm();break;
      case 'new-document':documentForm();break;
      case 'new-sale':documentForm('sale');break;
      case 'new-purchase':documentForm('purchase');break;
      case 'new-inventory':inventoryForm();break;
      case 'new-expense':expenseForm();break;
      case 'show-low':view='products';stockFilter='low';render();break;
      case 'filter-documents':documentFilter=data.filter;render();break;
      case 'export-products':exportProducts();break;
      case 'export-documents':exportDocuments();break;
      case 'export-report':exportDocuments(reportDocuments());break;
      case 'export-reorder':exportCSV('reapprovisionnement',['SKU','Produit','Stock','Seuil','À commander'],state.products.filter(p=>qty(p.id)<=p.minStock).map(p=>[p.sku,p.name,qty(p.id),p.minStock,Math.max(0,p.minStock*2-qty(p.id))]));break;
      case 'backup':download('comptoir-donnees-'+today()+'.json',JSON.stringify({...state,exportedAt:new Date().toISOString()},null,2),'application/json');toast('Instantané JSON téléchargé (sans images ni comptes).');break;
      case 'import-products':importProducts();break;
      case 'sync':await sync();pendingDialog();break;
      case 'logout':
        if(!navigator.onLine){toast('La déconnexion sécurisée nécessite une connexion au serveur.',true);break;}
        try{await api('/api/logout',{});await local.remove('lastUser');await local.remove('state:'+user.id);user=null;state=null;view='dashboard';closeModal();renderLogin();}
        catch(error){toast(error.message,true);}
        break;
    }
  }
  function renderLogin(message='') {
    document.body.classList.remove('nav-open');
    root.innerHTML=`<div class="login-shell"><section class="login-art"><a class="brand" href="/"><span class="brand-icon">${icon('box')}</span>comptoir<span class="brand-dot">.</span></a><div class="login-art-copy"><div class="eyebrow">LE BON STOCK. AU BON MOMENT.</div><h1>Votre commerce,<br>l’esprit tranquille.</h1><p>Du premier article au dernier inventaire, retrouvez l’essentiel de votre activité dans un seul espace.</p><div class="login-feature">${icon('box')}Un catalogue toujours à portée de main</div><div class="login-feature">${icon('arrows')}Chaque mouvement, suivi et enregistré</div><div class="login-feature">${icon('clipboard')}Des inventaires simples et précis</div></div><div class="login-art-footer">Pensé pour les commerces qui avancent.</div><div class="login-decoration">${icon('box')}</div></section><section class="login-card"><span class="login-mobile-brand">comptoir.</span><div class="eyebrow">BIENVENUE DANS VOTRE ESPACE</div><h2>Ouvrons votre comptoir.</h2><p class="subtitle">Connectez-vous pour suivre votre commerce.</p><form id="login-form">${field('Adresse e-mail','email','',{type:'email',required:true,placeholder:'vous@votre-commerce.fr'})}${field('Mot de passe','password','',{type:'password',required:true})}<div class="form-error" role="alert">${esc(message)}</div><button type="submit" class="btn primary login-submit">Se connecter${icon('chevron')}</button></form>${demoMode?`<div class="demo-accounts"><div class="demo-heading"><span class="badge purple">DÉMONSTRATION LOCALE</span><p>Explorez l’application avec des données fictives.</p></div>${[['admin','Administrateur','Toutes les fonctionnalités','settings'],['cashier','Caissier','Ventes et catalogue sans coûts d’achat','cart'],['inventory','Agent d’inventaire','Comptage sans données financières','clipboard']].map(([role,title,detail,name])=>`<button class="demo-account" data-demo="${role}">${icon(name)}<span><strong>${title}</strong><small>${detail}</small></span>${icon('chevron')}</button>`).join('')}</div>`:''}<p class="login-security">${icon('check')}Accès protégé · Données conservées sur votre serveur</p></section></div>`;
    $('#login-form').addEventListener('submit',async e=>{e.preventDefault();await login($('#field-email').value,$('#field-password').value);});
    $$('[data-demo]').forEach(el=>el.addEventListener('click',()=>login(el.dataset.demo+'@stock.local','Demo2026!')));
  }
  async function login(email,password) {
    $$('button',root).forEach(b=>b.disabled=true);
    try{await api('/api/login',{email,password});await refresh();view='dashboard';render();await sync();}
    catch(error){renderLogin(error.message);}
  }
  async function init() {
    if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
    try{
      const config=await api('/api/config');demoMode=config.demoMode;
      await refresh();render();await sync();
    }catch(error){
      if(!error.status){
        try{const savedUser=await local.get('lastUser');const savedState=savedUser&&await local.get('state:'+savedUser.id);if(savedState){user=savedUser;state=savedState;storeId=state.stores[0]?.id||'all';cached=true;pending=await local.pending(user.id);render();return;}}catch{}
      }
      renderLogin(error.status===401?'':error.message);
    }
  }
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){closeModal();document.body.classList.remove('nav-open');}
    if(event.key==='Tab'&&modalRoot.firstChild){const focusable=$$('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',modalRoot).filter(el=>el.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){last?.focus();event.preventDefault();}else if(!event.shiftKey&&document.activeElement===last){first?.focus();event.preventDefault();}}
  });
  window.addEventListener('online',()=>sync());
  window.addEventListener('offline',()=>{cached=true;updateSync();});
  // A network may recover without firing "online" (for example after an
  // offline reload or a temporary server outage). Retry the retained outbox.
  setInterval(()=>{
    if(user && navigator.onLine && (cached || pending.some(item=>!item.error))) sync();
  },5000);
  init();
})();
