// Progetti (cartelle sul disco usate da npm, git, env…) e cartelle della sidebar che li
// raggruppano: sezioni "projects" e "projectFolders" di config.json. Sono del core perché
// le condividono più estensioni. Un solo livello: le cartelle contengono solo progetti,
// un progetto senza cartella sta nella radice.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { registerSection, loadConfig, saveConfig, pick } = require('./config');
const { coreError } = require('./errors');
const { KEY_RE, isText } = require('./validate');

const PROJECT_FIELDS = ['id', 'label', 'path', 'folder'];
const FOLDER_FIELDS = ['id', 'label'];

const normalizeList = fields => v => (Array.isArray(v) ? v.map(x => pick(x || {}, fields)) : v);

function uniqueIds(list, error) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) throw coreError.config(error, { id: x.id });
    seen.add(x.id);
  }
}

function validateFolders(list) {
  if (!Array.isArray(list)) throw coreError.config('not_a_list', { section: 'projectFolders' });
  for (const f of list) {
    if (!f || typeof f !== 'object' || !KEY_RE.test(f.id || '')) throw coreError.config('folder_id', { id: String(f?.id ?? '') });
    if (!isText(f.label, 100)) throw coreError.config('folder_label', { id: f.id });
  }
  uniqueIds(list, 'duplicate_folder');
}

// cfg: config intera, per controllare che la cartella di ogni progetto esista
function validateProjects(list, cfg) {
  if (!Array.isArray(list)) throw coreError.config('not_a_list', { section: 'projects' });
  const folders = new Set((Array.isArray(cfg?.projectFolders) ? cfg.projectFolders : []).map(f => f?.id));
  for (const p of list) {
    if (!p || typeof p !== 'object') throw coreError.config('project_invalid');
    const bad = name => coreError.config(name, { id: String(p.id ?? '') });
    if (!KEY_RE.test(p.id || '')) throw bad('project_id');
    if (!isText(p.label)) throw bad('project_label');
    if (!isText(p.path, 1024) || !path.isAbsolute(p.path)) throw bad('project_path');
    if (p.folder !== undefined && !folders.has(p.folder)) throw coreError.config('project_folder', { id: p.id, folder: String(p.folder) });
  }
  uniqueIds(list, 'duplicate_project');
}

registerSection('projectFolders', { owner: 'core', empty: [], idField: 'id', normalize: normalizeList(FOLDER_FIELDS), validate: validateFolders });
registerSection('projects', { owner: 'core', empty: [], idField: 'id', normalize: normalizeList(PROJECT_FIELDS), validate: validateProjects });

// ---- lettura ----

const list = () => loadConfig().projects;
const get = id => list().find(p => p.id === id) || null;
const folders = () => loadConfig().projectFolders;

// ---- modifica (errori come ApiError del core) ----

// folder: id di una cartella, oppure ''/null per la radice
function folderField(cfg, folder) {
  if (folder === undefined) return undefined;
  if (folder === null || folder === '') return null;
  if (!cfg.projectFolders.some(f => f.id === folder)) throw coreError(400, 'folder_unknown', { folder: String(folder) });
  return folder;
}

function checkPath(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw coreError(400, 'path_absolute');
  if (!fs.existsSync(projectPath)) throw coreError(400, 'path_not_found', { path: projectPath });
}

function createProject(body = {}) {
  const { id, label, path: projectPath } = body;
  if (!id || !label || !projectPath) throw coreError(400, 'project_fields');
  const cfg = loadConfig();
  if (cfg.projects.some(p => p.id === id)) throw coreError(409, 'project_exists', { id: String(id) });
  checkPath(projectPath);
  const folder = folderField(cfg, body.folder);
  const p = { id, label, path: projectPath, ...(folder ? { folder } : {}) };
  cfg.projects = [...cfg.projects, p];
  saveConfig(cfg);
  return p;
}

// Solo nome, percorso e cartella: l'id non cambia
function updateProject(id, body = {}) {
  const cfg = loadConfig();
  const p = cfg.projects.find(x => x.id === id);
  if (!p) throw coreError(404, 'project_not_found', { id: String(id) });
  if (body.path !== undefined) checkPath(body.path);
  Object.assign(p, pick(body, ['label', 'path']));
  const folder = folderField(cfg, body.folder);
  if (folder === null) delete p.folder;
  else if (folder) p.folder = folder;
  saveConfig(cfg);
  return p;
}

function deleteProject(id) {
  const cfg = loadConfig();
  cfg.projects = cfg.projects.filter(p => p.id !== id);
  saveConfig(cfg);
}

function createFolder(body = {}) {
  const cfg = loadConfig();
  const f = { id: `f${crypto.randomBytes(4).toString('hex')}`, label: typeof body.label === 'string' ? body.label.trim() : '' };
  if (!isText(f.label, 100)) throw coreError(400, 'folder_label_required');
  cfg.projectFolders = [...cfg.projectFolders, f];
  saveConfig(cfg);
  return f;
}

function updateFolder(id, body = {}) {
  const cfg = loadConfig();
  const f = cfg.projectFolders.find(x => x.id === id);
  if (!f) throw coreError(404, 'folder_unknown', { folder: String(id) });
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!isText(label, 100)) throw coreError(400, 'folder_label_required');
  f.label = label;
  saveConfig(cfg);
  return f;
}

// I progetti della cartella tornano nella radice (stessa scrittura)
function deleteFolder(id) {
  const cfg = loadConfig();
  cfg.projectFolders = cfg.projectFolders.filter(f => f.id !== id);
  for (const p of cfg.projects) if (p.folder === id) delete p.folder;
  saveConfig(cfg);
}

module.exports = {
  list, get, folders,
  createProject, updateProject, deleteProject,
  createFolder, updateFolder, deleteFolder,
};
