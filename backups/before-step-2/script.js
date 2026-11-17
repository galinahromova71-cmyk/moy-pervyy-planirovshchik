'use strict';

// Схема 1: {schemaVersion: 1, posts: [{id,title,date,time,status,category,format,
// notes,body,links:[{label,url}],createdAt,updatedAt,archivedAt}], settings: {}}.
const STORAGE_KEY = 'planner_data';
const DRAFT_KEY = 'planner_editor_draft';
const CONFIG = Object.freeze({
  statuses: ['Идея', 'В работе', 'Готово', 'Опубликовано'],
  categories: ['Бухгалтерия', 'Управленческий учёт', 'Бюджетирование', 'Финансовый директор (CFO)', 'Бизнес и финансы', 'Практика и кейсы'],
  formats: ['Пост', 'Инструкция', 'Подборка', 'Кейс', 'Мнение']
});
const $ = id => document.getElementById(id);
const form = $('post-form');
const fieldNames = ['title', 'date', 'time', 'status', 'category', 'format', 'notes', 'body'];
let data = { schemaVersion: 1, posts: [], settings: {} };
let storageBlocked = false;
let editingId = null;
let viewedId = null;
let baseline = '';
let draftTimer;
let pendingDraft = null;

function message(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('is-error', error);
  $('notice').hidden = false;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T12:00:00');
  return !Number.isNaN(d.getTime()) && d.getFullYear() === Number(value.slice(0,4)) && d.getMonth() + 1 === Number(value.slice(5,7)) && d.getDate() === Number(value.slice(8,10));
}
function validURL(value) {
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
function validFields(p, allowIncomplete = false) {
  return p && fieldNames.every(k => typeof p[k] === 'string') &&
    (allowIncomplete || (p.title.trim() && (!p.date || validDate(p.date)) && (!p.time || (p.date && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time))))) &&
    CONFIG.statuses.includes(p.status) && (!p.category || CONFIG.categories.includes(p.category)) && (!p.format || CONFIG.formats.includes(p.format)) &&
    Array.isArray(p.links) && p.links.every(l => l && typeof l.label === 'string' && typeof l.url === 'string' && (allowIncomplete || validURL(l.url)));
}
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.posts) || !parsed.settings || typeof parsed.settings !== 'object' ||
        !parsed.posts.every(p => validFields(p) && typeof p.id === 'string' && p.id && typeof p.createdAt === 'string' && typeof p.updatedAt === 'string' && (p.archivedAt === null || typeof p.archivedAt === 'string')) ||
        new Set(parsed.posts.map(p => p.id)).size !== parsed.posts.length) throw new Error('Некорректные данные');
      data = parsed;
    }
  } catch {
    storageBlocked = true;
    message('Не удалось прочитать сохранённые данные. Они не удалены. Сохранение новых записей остановлено, чтобы не перезаписать их.', true);
  }
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw !== null) {
      const draft = JSON.parse(raw);
      if (!validFields(draft.fields, true) || !(draft.id === null || typeof draft.id === 'string')) throw new Error('Черновик повреждён');
      pendingDraft = draft;
      $('recovery').hidden = false;
    }
  } catch { message('Не удалось прочитать незавершённую форму. Сохранённые публикации не изменены.', true); }
}
function fillSelect(id, values, optional) {
  if (optional) $(id).add(new Option('Не выбрано', ''));
  values.forEach(value => $(id).add(new Option(value, value)));
}
function readFields() {
  const values = Object.fromEntries(fieldNames.map(k => [k, $(k).value]));
  values.links = [...$('links').children].map(row => ({label: row.querySelector('[data-label]').value, url: row.querySelector('[data-url]').value}));
  return values;
}
function isDirty() { return JSON.stringify(readFields()) !== baseline; }
function addLink(link = {label:'', url:''}) {
  const row = document.createElement('div'); row.className = 'link-row';
  const label = document.createElement('label'); label.textContent = 'Название материала';
  const name = document.createElement('input'); name.dataset.label = ''; name.value = link.label; label.append(name);
  const urlLabel = document.createElement('label'); urlLabel.textContent = 'Ссылка (http:// или https://)';
  const url = document.createElement('input'); url.type = 'url'; url.dataset.url = ''; url.value = link.url; url.placeholder = 'https://…'; urlLabel.append(url);
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Убрать ссылку';
  remove.addEventListener('click', () => { row.remove(); scheduleDraft(); });
  row.append(label, urlLabel, remove); $('links').append(row);
}
function syncTime() { $('time').disabled = !$('date').value; if ($('time').disabled) $('time').value = ''; }
function openEditor(post = null, recovered = false) {
  if (pendingDraft && !recovered) {
    message('Сначала восстановите или удалите незавершённую форму в блоке выше.');
    $('recovery').scrollIntoView({block:'center'}); return;
  }
  editingId = post?.id || null;
  form.reset(); $('links').replaceChildren(); $('form-error').hidden = true;
  $('title-error').textContent = ''; $('title').removeAttribute('aria-invalid');
  fieldNames.forEach(k => { $(k).value = post?.[k] ?? (k === 'status' ? 'Идея' : ''); });
  (post?.links || []).forEach(addLink); syncTime();
  $('editor-title').textContent = editingId ? 'Редактирование публикации' : 'Новая публикация';
  $('draft-state').textContent = 'Изменения применятся после сохранения.';
  baseline = JSON.stringify(readFields());
  if (recovered) baseline = ''; // Восстановленная форма всё ещё требует явного сохранения.
  $('editor').showModal(); $('title').focus();
}
function saveDraft() {
  clearTimeout(draftTimer);
  if (!$('editor').open) return;
  if (!isDirty()) { clearDraft(); $('draft-state').textContent = 'Изменений нет.'; return; }
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({id: editingId, fields: readFields(), savedAt: new Date().toISOString()}));
    $('draft-state').textContent = 'Временная копия формы сохранена в браузере.';
  } catch {
    $('draft-state').textContent = 'Не удалось сохранить временную копию. Текст остаётся в открытой форме. Не закрывайте её до сохранения.';
  }
}
function scheduleDraft() {
  $('draft-state').textContent = 'Сохраняем временную копию…';
  clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 600);
}
function clearDraft() {
  clearTimeout(draftTimer);
  try { localStorage.removeItem(DRAFT_KEY); pendingDraft = null; $('recovery').hidden = true; return true; }
  catch { message('Не удалось удалить временную копию. При следующем открытии браузер может предложить её повторно.', true); return false; }
}
function closeEditor() { clearTimeout(draftTimer); $('editor').close(); }
function requestClose() {
  if (isDirty()) $('unsaved').showModal();
  else { clearDraft(); closeEditor(); }
}
function formError(text) { $('form-error').textContent = text; $('form-error').hidden = false; $('form-error').scrollIntoView({block:'nearest'}); }
function savePost() {
  $('form-error').hidden = true; $('title-error').textContent = ''; $('title').removeAttribute('aria-invalid');
  const values = readFields();
  ['title','category','format'].forEach(k => { values[k] = values[k].trim(); });
  values.links = values.links.filter(l => l.label.trim() || l.url.trim()).map(l => ({label:l.label.trim(), url:l.url.trim()}));
  if (!values.title) { $('title-error').textContent = 'Укажите тему публикации.'; $('title').setAttribute('aria-invalid','true'); $('title').focus(); return false; }
  if (!validFields(values)) { formError('Проверьте дату, время и ссылки. Для материалов нужен полный адрес с http:// или https://.'); return false; }
  if (storageBlocked) { formError('Сохранение недоступно: прежние данные не удалось прочитать. Они не будут перезаписаны.'); saveDraft(); return false; }
  const previous = data.posts.find(p => p.id === editingId);
  const now = new Date().toISOString();
  const post = {...values, id: previous?.id || crypto.randomUUID(), createdAt:previous?.createdAt || now, updatedAt:now, archivedAt:previous?.archivedAt || null};
  const next = {...data, posts: previous ? data.posts.map(p => p.id === post.id ? post : p) : [...data.posts, post]};
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch {
    saveDraft(); formError('Публикация не сохранена: браузер не разрешил запись или закончилось место. Введённый текст остаётся в форме.'); return false;
  }
  data = next; const removed = clearDraft(); closeEditor(); renderPosts();
  if (removed) message('Публикация сохранена в этом браузере.');
  return true;
}
function renderPosts() {
  $('posts').replaceChildren();
  const posts = data.posts.filter(p => !p.archivedAt);
  $('post-count').textContent = posts.length; $('empty').hidden = posts.length > 0;
  posts.forEach(post => {
    const button = document.createElement('button'); button.className = 'post-card';
    const status = document.createElement('span'); status.className = 'status'; status.textContent = post.status;
    const title = document.createElement('strong'); title.textContent = post.title;
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = [post.date ? post.date.split('-').reverse().join('.') : 'Без даты', post.time, post.category].filter(Boolean).join(' · ');
    button.append(status,title,meta); button.addEventListener('click', () => viewPost(post.id)); $('posts').append(button);
  });
}
function viewPost(id) {
  const post = data.posts.find(p => p.id === id); if (!post) return;
  viewedId = id; $('viewer-title').textContent = post.title; $('view-content').replaceChildren();
  [['Статус',post.status],['Плановая дата',post.date ? post.date.split('-').reverse().join('.') : 'Не назначена'],['Время',post.time],['Рубрика',post.category],['Формат',post.format],['Заметки',post.notes],['Черновик',post.body]].forEach(([name,value]) => {
    if (!value) return;
    const heading = document.createElement('h3'); heading.textContent = name;
    const text = document.createElement('p'); text.textContent = value; $('view-content').append(heading,text);
  });
  post.links.forEach(link => { const a = document.createElement('a'); a.textContent = link.label || link.url; a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('view-content').append(a); });
  $('viewer').showModal();
}
const sections = {plan:'Мой план',calendar:'Календарь',ideas:'Идеи',statuses:'Статусы',more:'Ещё',archive:'Архив',help:'Справка',data:'Данные и резервная копия'};
function navigate(section) {
  $('page-title').textContent = sections[section];
  document.querySelectorAll('[data-section]').forEach(b => { b.removeAttribute('aria-current'); if (b.dataset.section === section) b.setAttribute('aria-current','page'); });
  $('posts-section').hidden = section !== 'plan'; $('more-menu').hidden = section !== 'more'; $('placeholder').hidden = ['plan','more'].includes(section);
  $('page-subtitle').textContent = section === 'plan' ? 'От первой идеи до готовой публикации.' : 'Сейчас доступна работа с карточками публикаций в разделе «План».';
  $('placeholder-title').textContent = sections[section];
  $('placeholder-text').textContent = 'Этот раздел появится на следующих шагах разработки. Публикации уже можно создавать, просматривать и редактировать в разделе «План».';
}
fillSelect('status', CONFIG.statuses, false); fillSelect('category', CONFIG.categories, true); fillSelect('format', CONFIG.formats, true);
document.querySelectorAll('[data-section]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.section)));
document.querySelector('.brand').addEventListener('click', () => navigate('plan'));
$('new-post').addEventListener('click', () => openEditor()); $('empty-create').addEventListener('click', () => openEditor());
$('add-link').addEventListener('click', () => { addLink(); scheduleDraft(); });
form.addEventListener('input', () => { syncTime(); scheduleDraft(); });
form.addEventListener('change', () => { syncTime(); scheduleDraft(); });
form.addEventListener('submit', e => { e.preventDefault(); savePost(); });
$('close-editor').addEventListener('click', requestClose); $('cancel-editor').addEventListener('click', requestClose);
$('editor').addEventListener('cancel', e => { e.preventDefault(); requestClose(); });
$('keep-editing').addEventListener('click', () => $('unsaved').close());
$('discard-edit').addEventListener('click', () => { clearDraft(); $('unsaved').close(); closeEditor(); });
$('save-edit').addEventListener('click', () => { $('unsaved').close(); savePost(); });
$('close-viewer').addEventListener('click', () => $('viewer').close());
$('edit-post').addEventListener('click', () => { $('viewer').close(); openEditor(data.posts.find(p => p.id === viewedId)); });
$('recover').addEventListener('click', () => {
  if (!pendingDraft) return;
  const draft = pendingDraft; pendingDraft = null; $('recovery').hidden = true;
  const id = data.posts.some(p => p.id === draft.id) ? draft.id : null;
  openEditor({...draft.fields, id}, true);
});
$('discard-draft').addEventListener('click', clearDraft);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });
window.addEventListener('pagehide', saveDraft);
loadData(); renderPosts();
