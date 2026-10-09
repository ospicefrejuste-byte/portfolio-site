/* Local demonstration only. These public accounts simulate roles; they are not authentication. */
(function demoBrowser(global) {
  'use strict';
  const seed = structuredClone(global.ComptoirDemoSeed);
  // Preview services can add a remote <base>; a local brand link must not leave the demo.
  document.addEventListener('click', event => {
    if (event.target.closest?.('a[href="#"]')) event.preventDefault();
  });
  let users = seed._demoUsers.map(({id,email,name,role}) => ({id,email,name,role,active:true,demo:true}));
  const copy = value => structuredClone(value);
  const problem = (message,status=400,code='demo_error') => Object.assign(new Error(message),{status,code});
  const database = new Promise((resolve,reject) => {
    const request = indexedDB.open('Comptoir-demo-business',1);
    request.onupgradeneeded = () => request.result.createObjectStore('business');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(problem('Le stockage local est indisponible. Autorisez le stockage de ce fichier dans votre navigateur.',503,'storage_unavailable'));
    request.onblocked = () => reject(problem('Fermez les autres fenêtres de cette démonstration, puis ouvrez à nouveau le fichier.',503,'storage_blocked'));
  });
  async function storage(mode,callback) {
    const db = await database;
    return new Promise((resolve,reject) => {
      const tx = db.transaction('business',mode);
      const request = callback(tx.objectStore('business'));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(problem('Enregistrement local impossible. Aucune modification métier n’a été validée.',503,'storage_unavailable'));
    });
  }
  let core, currentUser = null, chain = Promise.resolve();
  const ready = (async () => {
    const initial = new global.ComptoirDemoCore(seed).exportState();
    const saved = await storage('readwrite',store => {
      const request = store.get('snapshot');
      request.onsuccess = () => { if (!request.result) store.put(initial,'snapshot'); };
      return request;
    });
    core = new global.ComptoirDemoCore(saved || initial);
    const profiles = await storage('readonly',store=>store.get('profiles'));
    if(profiles)users=profiles;else await storage('readwrite',store=>store.put(users,'profiles'));
    const session = await storage('readonly',store => store.get('session'));
    currentUser = users.find(user => user.id === session?.userId) || null;
  })();
  // A rejected initialization is reported by request(), without an unhandled promise rejection.
  ready.catch(() => {});
  const requireUser = async () => {
    users=await storage('readonly',store=>store.get('profiles')) || users;
    const session=await storage('readonly',store=>store.get('session'));
    currentUser=session?.userId===currentUser?.id?users.find(user=>user.id===currentUser.id&&user.active!==false):null;
    if (!currentUser) throw problem('Choisissez un compte de démonstration pour ouvrir votre comptoir.',401,'session_required');
    return currentUser;
  };
  async function updateProfile(data,id) {
    const actor=await requireUser();
    if(actor.role!=='admin')throw problem('Action réservée au profil administrateur.',403,'forbidden');
    if(!data||Object.keys(data).some(key=>!['name','email','role','active'].includes(key)))throw problem('Profil de démonstration invalide. Ne saisissez aucun mot de passe personnel.');
    const db=await database;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('business','readwrite'),store=tx.objectStore('business'),sessionRequest=store.get('session'),req=store.get('profiles');
      let result,failure,next;
      req.onsuccess=()=>{
        try {
          next=req.result||users;
          if(sessionRequest.result?.userId!==actor.id||!next.some(user=>user.id===actor.id&&user.role==='admin'&&user.active))throw problem('Accès modifiés. Choisissez à nouveau un profil.',401);
          const previous=id&&next.find(user=>user.id===id);
          if(id&&!previous)throw problem('Profil introuvable.',404);
          const value={...previous,...data,id:id||crypto.randomUUID(),demo:true};
          value.email=String(value.email||'').trim().toLowerCase();value.name=String(value.name||'').trim();
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)||value.email.length>254||!value.name||value.name.length>160||!['admin','cashier','inventory'].includes(value.role)||typeof value.active!=='boolean')throw problem('Nom, e-mail, rôle ou statut invalide.');
          if(next.some(user=>user.id!==value.id&&user.email===value.email))throw problem('Cette adresse est déjà utilisée.',409);
          next=next.filter(user=>user.id!==value.id).concat(value);
          if(!next.some(user=>user.role==='admin'&&user.active))throw problem('Conservez au moins un administrateur actif.',409);
          store.put(next,'profiles');result={user:value};
          if(previous&&previous.id===actor.id&&(previous.role!==value.role||previous.active!==value.active||previous.email!==value.email))store.delete('session');
        }catch(error){failure=error;tx.abort();}
      };
      tx.oncomplete=()=>{users=next;resolve(copy(result));};
      tx.onerror=tx.onabort=()=>reject(failure||problem('Profil non enregistré.',503));
    });
  }
  async function clearCache() {
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('comptoir-demo-cache',1);req.onupgradeneeded=()=>{req.result.createObjectStore('cache');req.result.createObjectStore('commands',{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    try {await new Promise((resolve,reject)=>{const tx=db.transaction(['cache','commands'],'readwrite');tx.objectStore('cache').clear();tx.objectStore('commands').clear();tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  const readFile = file => new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(problem('Cette photo ne peut pas être lue.',400,'invalid_photo'));
    reader.readAsDataURL(file);
  });
  async function execute(path,data,method=data?'POST':'GET') {
    await ready;
    if(path==='/api/admin/users'&&method==='POST')return updateProfile(data);
    if(path.startsWith('/api/admin/users/')&&method==='PATCH')return updateProfile(data,decodeURIComponent(path.slice('/api/admin/users/'.length)));
    switch (path) {
      case '/api/config': return {demoMode:true,localDemo:true};
      case '/api/session': return {user:currentUser ? copy(currentUser) : null,demo:true};
      case '/api/login': {
        users=await storage('readonly',store=>store.get('profiles'))||users;
        const user = users.find(user => user.active!==false&&user.email.toLowerCase() === String(data?.email || '').trim().toLowerCase());
        if (!user || data?.password !== 'Demo2026!') throw problem('Utilisez un des comptes de démonstration ci-dessous (mot de passe public : Demo2026!).',401,'invalid_demo_account');
        await storage('readwrite',store => store.put({userId:user.id},'session'));
        currentUser = user;
        return {user:copy(user),demo:true};
      }
      case '/api/logout':
        await storage('readwrite',store => store.delete('session'));
        currentUser = null;
        return {ok:true};
      case '/api/state': {
        const user = await requireUser();
        const saved = await storage('readonly',store => store.get('snapshot'));
        core = new global.ComptoirDemoCore(saved || seed);
        return {...copy(core.state(user)),user:copy(user)};
      }
      case '/api/commands': {
        const user = await requireUser();
        const db = await database;
        // IndexedDB serializes this transaction across windows. Read, validate and write
        // the latest snapshot together; a failure aborts the write and its in-memory draft.
        return new Promise((resolve,reject) => {
          const tx = db.transaction('business','readwrite');
          const store = tx.objectStore('business');
          const request = store.get('snapshot'), sessionRequest=store.get('session'),profilesRequest=store.get('profiles');
          let nextCore, result, failure;
          profilesRequest.onsuccess = () => {
            try {
              const actor=(profilesRequest.result||users).find(profile=>profile.id===user.id&&profile.active);
              if(sessionRequest.result?.userId!==user.id||!actor)throw problem('Choisissez à nouveau un profil.',401);
              nextCore = new global.ComptoirDemoCore(request.result || seed);
              result = nextCore.command(actor,copy(data));
              store.put(nextCore.exportState(),'snapshot');
            } catch (error) { failure = error; tx.abort(); }
          };
          tx.oncomplete = () => { core = nextCore; resolve(copy(result)); };
          tx.onerror = tx.onabort = () => reject(failure || problem('Enregistrement local impossible. Aucune modification métier n’a été validée.',503,'storage_unavailable'));
        });
      }
      case '/upload': {
        await requireUser();
        if (currentUser.role !== 'admin') throw problem('Les photos se modifient avec le rôle administrateur de démonstration.',403,'forbidden');
        if (!(data instanceof FormData)) throw problem('Aucune photo sélectionnée.',400,'invalid_photo');
        const files = data.getAll('images');
        if (!files.length || files.length > 4) throw problem('Sélectionnez entre une et quatre photos.',400,'invalid_photo');
        const photos = [];
        for (const file of files) {
          if (!(file instanceof File) || !['image/png','image/jpeg','image/webp'].includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) {
            throw problem('Photo invalide : PNG, JPEG ou WebP, 5 Mo maximum.',400,'invalid_photo');
          }
          const photo = await readFile(file);
          if (!/^data:image\/(png|jpeg|webp);base64,/.test(photo)) throw problem('Format de photo invalide.',400,'invalid_photo');
          photos.push(photo);
        }
        return photos;
      }
      case '/api/admin/users': {
        if((await requireUser()).role!=='admin')throw problem('Profil administrateur requis.',403);
        return {users:copy(users)};
      }
      case '/api/demo/backup': {
        if((await requireUser()).role!=='admin')throw problem('Profil administrateur requis.',403);
        const db=await database;
        return new Promise((resolve,reject)=>{
          const tx=db.transaction('business','readonly'),store=tx.objectStore('business'),snapshot=store.get('snapshot'),profiles=store.get('profiles');
          tx.oncomplete=()=>resolve({format:'comptoir-demo-backup',version:1,exportedAt:new Date().toISOString(),state:copy(snapshot.result),profiles:copy(profiles.result)});
          tx.onerror=()=>reject(problem('Sauvegarde locale indisponible.',503));
        });
      }
      case '/api/demo/restore': {
        if((await requireUser()).role!=='admin')throw problem('Profil administrateur requis.',403);
        const backup=global.ComptoirDemoBackups.validateBackup(data?.backup);
        await storage('readwrite',store=>{store.put(backup.state,'snapshot');store.put(backup.profiles,'profiles');return store.delete('session');});
        currentUser=null;users=backup.profiles;core=new global.ComptoirDemoCore(backup.state);
        await clearCache();return {ok:true,relogin:true};
      }
      default: throw problem('Cette opération ne fait pas partie de la démonstration locale.',404,'unknown_operation');
    }
  }
  global.ComptoirDemoAPI = Object.freeze({
    request(path,data,method=data?'POST':'GET') {
      // Commands and session changes use one queue so a write cannot be lost to an overlapping request.
      const result = chain.then(() => execute(path,data,method));
      chain = result.catch(() => {});
      return result;
    },
    async uploadResponse(body) {
      try {
        const result = await this.request('/upload',body);
        return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
      } catch (error) {
        return new Response(JSON.stringify({error:error.message,code:error.code}),{status:error.status || 400,headers:{'Content-Type':'application/json'}});
      }
    }
  });
})(window);
