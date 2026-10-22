// Progetti e cartelle della sidebar, condivisi dalle estensioni (npm, git, env…): albero
// a un livello (cartelle con i loro progetti, poi i progetti senza cartella), modulo del
// progetto con la scelta della cartella, creazione/rinomina/eliminazione delle cartelle.
// Le estensioni lo usano tramite ctx.projects; dopo ogni modifica parte l'evento
// "core:projects-changed" sul bus.
window.Projects = (() => {
  const { esc, js, toast, openModal, closeModal, apiClient, contextMenu } = window.UI;
  const { t, fmt } = window.I18n;
  const api = apiClient('/api/core');
  const COLLAPSED_KEY = 'devdock.projectFolders.collapsed';
  let onChange = () => {};
  let folders = []; // ultime cartelle lette, per il modulo del progetto

  // Cartelle chiuse: comuni a tutte le sezioni (localStorage può mancare o fallire)
  function collapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { return new Set(); }
  }
  function storeCollapsed(set) {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* solo per questa sessione */ }
  }

  async function load() {
    const data = await api.get('/projects');
    folders = data.folders;
    return data;
  }

  const changed = () => onChange();

  // HTML dell'albero. items: oggetti con un campo folder (progetti, repository…);
  // item(x) restituisce l'HTML della voce. Cartelle vuote comprese, così una cartella
  // appena creata si vede.
  function tree(folderList, items, item) {
    const closed = collapsed();
    const known = new Set(folderList.map(f => f.id));
    const inFolder = id => items.filter(x => x.folder === id);
    const chevron = open => `<svg class="pf-chevron ${open ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>`;
    return folderList.map(f => {
      const children = inFolder(f.id);
      const open = !closed.has(f.id);
      return `<div class="pf-folder ${open ? '' : 'collapsed'}" data-folder="${esc(f.id)}">
        <div class="pf-folder-head" role="button" tabindex="0" aria-expanded="${open}"
             onclick="Projects.toggle(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();Projects.toggle(this)}"
             oncontextmenu="event.preventDefault();Projects.folderMenu(event,${js(f.id)})">
          ${chevron(open)}<span class="pf-folder-icon">📁</span>
          <span class="pf-folder-label">${esc(f.label)}</span>
          <span class="sb-count">${esc(fmt.number(children.length))}</span>
          <button class="pf-folder-more" onclick="event.stopPropagation();Projects.folderMenu(event,${js(f.id)})" title="${esc(t('core.projects.folderActions'))}">⋯</button>
        </div>
        <div class="pf-children">${children.map(item).join('')}</div>
      </div>`;
    }).join('') + items.filter(x => !x.folder || !known.has(x.folder)).map(item).join('');
  }

  function toggle(head) {
    const box = head.closest('.pf-folder');
    const closed = collapsed();
    const nowOpen = box.classList.contains('collapsed');
    box.classList.toggle('collapsed', !nowOpen);
    head.setAttribute('aria-expanded', String(nowOpen));
    head.querySelector('.pf-chevron')?.classList.toggle('open', nowOpen);
    if (nowOpen) closed.delete(box.dataset.folder); else closed.add(box.dataset.folder);
    storeCollapsed(closed);
  }

  // ---- cartelle ----

  function folderMenu(event, id) {
    const rect = event.currentTarget?.getBoundingClientRect?.();
    const x = event.clientX || rect?.left || 0, y = event.clientY || rect?.bottom || 0;
    contextMenu(x, y, [
      { label: t('core.projects.renameFolder'), icon: '✎', action: () => folderForm(id) },
      { label: t('core.projects.deleteFolder'), icon: '🗑', danger: true, action: () => deleteFolder(id) },
    ]);
  }

  // Nuova cartella (id assente) o rinomina
  async function folderForm(id) {
    if (id) try { await load(); } catch (e) { toast(e.message, 'error'); return; }
    const f = id ? folders.find(x => x.id === id) : null;
    if (id && !f) return;
    openModal(t(f ? 'core.projects.renameFolder' : 'core.projects.newFolder'), `
      <div class="form-row"><label>${esc(t('core.projects.folderName'))}</label>
        <input class="form-input" id="f_folder_label" value="${esc(f?.label || '')}" placeholder="${esc(t('core.projects.folderPlaceholder'))}"
               onkeydown="if(event.key==='Enter')Projects.saveFolder(${js(id || '')})"></div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="Projects.saveFolder(${js(id || '')})">${esc(t(f ? 'core.action.save' : 'core.action.add'))}</button>`);
    document.getElementById('f_folder_label')?.focus();
  }

  async function saveFolder(id) {
    const label = (document.getElementById('f_folder_label')?.value || '').trim();
    if (!label) { toast(t('core.projects.folderNameRequired'), 'error'); return; }
    try {
      if (id) await api.put(`/folders/${encodeURIComponent(id)}`, { label });
      else await api.post('/folders', { label });
      closeModal();
      changed();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteFolder(id) {
    const f = folders.find(x => x.id === id);
    if (!confirm(t('core.projects.confirmDeleteFolder', { name: f?.label || id }))) return;
    try {
      await api.del(`/folders/${encodeURIComponent(id)}`);
      changed();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- progetti ----

  // Nuovo progetto (id assente) o modifica di nome, percorso e cartella
  async function form(id, { folder = '' } = {}) {
    let data;
    try { data = await load(); } catch (e) { toast(e.message, 'error'); return; }
    const p = id ? data.projects.find(x => x.id === id) : null;
    if (id && !p) return;
    const current = p ? p.folder || '' : folder;
    const options = [`<option value="">${esc(t('core.projects.noFolder'))}</option>`,
      ...data.folders.map(f => `<option value="${esc(f.id)}" ${f.id === current ? 'selected' : ''}>${esc(f.label)}</option>`)].join('');
    openModal(t(p ? 'core.projects.editTitle' : 'core.projects.newTitle'), `
      ${p ? '' : `<div class="form-row"><label>${esc(t('core.projects.id'))}</label><input class="form-input" id="f_proj_id" placeholder="${esc(t('core.projects.idPlaceholder'))}"></div>`}
      <div class="form-row"><label>${esc(t('core.projects.name'))}</label><input class="form-input" id="f_proj_label" value="${esc(p?.label || '')}" placeholder="${esc(t('core.projects.namePlaceholder'))}"></div>
      <div class="form-row"><label>${esc(t('core.projects.path'))}</label><input class="form-input" id="f_proj_path" value="${esc(p?.path || '')}" placeholder="/Users/me/projects/my-app"></div>
      <div class="form-row"><label>${esc(t('core.projects.folder'))}</label><select class="form-input" id="f_proj_folder">${options}</select></div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="Projects.save(${js(id || '')})">${esc(t(p ? 'core.action.save' : 'core.action.add'))}</button>`);
  }

  async function save(id) {
    const val = el => (document.getElementById(el)?.value || '').trim();
    const body = { label: val('f_proj_label'), path: val('f_proj_path'), folder: val('f_proj_folder') };
    if (!id) body.id = val('f_proj_id');
    if ((!id && !body.id) || !body.label || !body.path) { toast(t('core.projects.allRequired'), 'error'); return; }
    try {
      if (id) await api.put(`/projects/${encodeURIComponent(id)}`, body);
      else await api.post('/projects', body);
      closeModal();
      toast(t(id ? 'core.projects.saved' : 'core.projects.added'), 'success');
      changed();
    } catch (e) { toast(e.message, 'error'); }
  }

  // true se rimosso
  async function remove(id) {
    if (!confirm(t('core.projects.confirmRemove'))) return false;
    try {
      await api.del(`/projects/${encodeURIComponent(id)}`);
      toast(t('core.projects.removed'), 'success');
      changed();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  return {
    // usato dalla shell per collegare il bus
    setOnChange(fn) { onChange = fn; },
    load, tree, toggle, form, save, remove,
    newFolder: () => folderForm(null), folderMenu, saveFolder,
  };
})();
