/* Local demonstration only. These public accounts simulate roles; they are not authentication. */
(function demoBrowser(global) {
  'use strict';
  const seed = structuredClone(global.ComptoirDemoSeed);
  // Preview services can add a remote <base>; a local brand link must not leave the demo.
  document.addEventListener('click', event => {
    if (event.target.closest?.('a[href="#"]')) event.preventDefault();
  });
  const users = seed._demoUsers.map(({id,email,name,role}) => ({id,email,name,role}));
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
    const session = await storage('readonly',store => store.get('session'));
    currentUser = users.find(user => user.id === session?.userId) || null;
  })();
  // A rejected initialization is reported by request(), without an unhandled promise rejection.
  ready.catch(() => {});
  const requireUser = () => {
    if (!currentUser) throw problem('Choisissez un compte de démonstration pour ouvrir votre comptoir.',401,'session_required');
    return currentUser;
  };
  const readFile = file => new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(problem('Cette photo ne peut pas être lue.',400,'invalid_photo'));
    reader.readAsDataURL(file);
  });
  async function execute(path,data) {
    await ready;
    switch (path) {
      case '/api/config': return {demoMode:true,localDemo:true};
      case '/api/session': return {user:currentUser ? copy(currentUser) : null,demo:true};
      case '/api/login': {
        const user = users.find(user => user.email.toLowerCase() === String(data?.email || '').trim().toLowerCase());
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
        const user = requireUser();
        const saved = await storage('readonly',store => store.get('snapshot'));
        core = new global.ComptoirDemoCore(saved || seed);
        return {...copy(core.state(user)),user:copy(user)};
      }
      case '/api/commands': {
        const user = requireUser();
        const db = await database;
        // IndexedDB serializes this transaction across windows. Read, validate and write
        // the latest snapshot together; a failure aborts the write and its in-memory draft.
        return new Promise((resolve,reject) => {
          const tx = db.transaction('business','readwrite');
          const store = tx.objectStore('business');
          const request = store.get('snapshot');
          let nextCore, result, failure;
          request.onsuccess = () => {
            try {
              nextCore = new global.ComptoirDemoCore(request.result || seed);
              result = nextCore.command(user,copy(data));
              store.put(nextCore.exportState(),'snapshot');
            } catch (error) { failure = error; tx.abort(); }
          };
          tx.oncomplete = () => { core = nextCore; resolve(copy(result)); };
          tx.onerror = tx.onabort = () => reject(failure || problem('Enregistrement local impossible. Aucune modification métier n’a été validée.',503,'storage_unavailable'));
        });
      }
      case '/upload': {
        requireUser();
        if (currentUser.role !== 'admin') throw problem('Les photos se modifient avec le rôle administrateur de démonstration.',403,'forbidden');
        if (!(data instanceof FormData)) throw problem('Aucune photo sélectionnée.',400,'invalid_photo');
        const files = data.getAll('images');
        if (!files.length || files.length > 5) throw problem('Sélectionnez entre une et cinq photos.',400,'invalid_photo');
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
      default: throw problem('Cette opération ne fait pas partie de la démonstration locale.',404,'unknown_operation');
    }
  }
  global.ComptoirDemoAPI = Object.freeze({
    request(path,data) {
      // Commands and session changes use one queue so a write cannot be lost to an overlapping request.
      const result = chain.then(() => execute(path,data));
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
