'use strict';

// Схема 1: {schemaVersion: 1, posts: [{id,title,date,time,status,category,format,
// notes,body,links:[{label,url}],createdAt,updatedAt,archivedAt}], settings: {}}.
const STORAGE_KEY = 'planner_data';
const DRAFT_KEY = 'planner_editor_draft';
const IMPORT_UNDO_KEY = 'planner_import_undo';
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
let currentSection = 'plan';
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedDay = localDate(new Date());
let boardStatus = 'Идея';
let changeRequest = null;
const PAGE_SIZE = 50;
let listLimit = PAGE_SIZE;
let dayLimit = PAGE_SIZE;
let boardLimits = Object.fromEntries(CONFIG.statuses.map(s => [s, PAGE_SIZE]));
let archiveUndoId = null;
let deleteId = null;
let renderedToday = localDate(new Date());
let importUndo = null;
let importCandidate = null;
let importBaseline = '';
let importReadToken = 0;
let importNeedsNoUndo = false;

// JSON-копия имеет ту же схему 1, что основное хранилище. Снимок отмены
// хранится отдельно: {before: <схема 1>, after: <строка JSON после импорта>}.
// after позволяет не применить устаревшую отмену после сохранённых изменений.
function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function validateBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Файл должен содержать JSON-копию планировщика.');
  if (value.schemaVersion !== 1) throw new Error('Эта версия формата не поддерживается. Выберите копию формата 1.');
  if (!Array.isArray(value.posts) || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('В файле отсутствуют записи или настройки нужного формата.');
  if ('welcomeDismissed' in value.settings && typeof value.settings.welcomeDismissed !== 'boolean') throw new Error('Некорректные настройки в файле.');
  const ids = new Set();
  value.posts.forEach((p,index) => {
    if (!validFields(p) || typeof p.id !== 'string' || !p.id.trim() || !validTimestamp(p.createdAt) || !validTimestamp(p.updatedAt) || !(p.archivedAt === null || validTimestamp(p.archivedAt))) throw new Error('Некорректные поля публикации № '+(index+1)+'. Проверьте тему, дату, время, статус, ссылки и служебные даты.');
    if(ids.has(p.id)) throw new Error('В файле повторяются идентификаторы публикаций. Импорт отменён.');
    ids.add(p.id);
  });
  return {schemaVersion:1,posts:value.posts.map(p=>({...Object.fromEntries(fieldNames.map(k=>[k,p[k]])),id:p.id,createdAt:p.createdAt,updatedAt:p.updatedAt,archivedAt:p.archivedAt,links:p.links.map(l=>({label:l.label,url:l.url}))})),settings:JSON.parse(JSON.stringify(value.settings))};
}
function updateDataUI() {
  const archived=data.posts.filter(p=>p.archivedAt).length;
  $('data-counts').textContent='Активных записей: '+(data.posts.length-archived)+'. В архиве: '+archived+'.';
  $('undo-import').disabled=!importUndo;
  $('welcome').hidden=Boolean(data.settings.welcomeDismissed) || storageBlocked;
}
function invalidateImportUndo() {
  importUndo=null;
  try {localStorage.removeItem(IMPORT_UNDO_KEY);} catch { /* После перезапуска несовпадающий after также блокирует отмену. */ }
  updateDataUI();
}
function loadImportUndo() {
  importUndo=null;
  try {
    const raw=localStorage.getItem(IMPORT_UNDO_KEY);
    if(raw && !storageBlocked){
      const snapshot=JSON.parse(raw);
      const before=validateBackup(snapshot.before);
      if(typeof snapshot.after==='string' && snapshot.after===localStorage.getItem(STORAGE_KEY))importUndo={before,after:snapshot.after};
      else localStorage.removeItem(IMPORT_UNDO_KEY);
    }
  } catch { /* Некорректный снимок не даёт права изменять основные данные. */ }
  updateDataUI();
}
function dataError(text) { $('data-error').textContent=text; $('data-error').hidden=false; }
function downloadError(text) { if($('import-dialog').open)showImportError(text);else dataError(text); }
function downloadBackup() {
  $('data-error').hidden=true;
  if(storageBlocked){downloadError('Сохранённые данные не удалось прочитать. Экспорт остановлен, чтобы не выдать пустую копию вместо них.');return false;}
  let url;
  try {
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='planner-backup-'+localDate(new Date())+'.json';document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    message('Браузер получил резервную копию для скачивания. Сохраните файл в надёжном месте.');return true;
  } catch {if(url)URL.revokeObjectURL(url);downloadError('Не удалось подготовить файл. Попробуйте скачать копию ещё раз.');return false;}
}
function currentStorageMatches() {
  const raw=localStorage.getItem(STORAGE_KEY);
  return raw===null ? data.posts.length===0 && Object.keys(data.settings).length===0 : JSON.stringify(validateBackup(JSON.parse(raw)))===JSON.stringify(validateBackup(data));
}
async function readImport(file) {
  const token=++importReadToken;importCandidate=null;$('data-error').hidden=true;
  if(!file)return;
  if(storageBlocked){dataError('Основные данные не удалось прочитать. Импорт остановлен, чтобы не перезаписать их.');return;}
  if(pendingDraft){dataError('Сначала восстановите или удалите незавершённую форму в блоке выше. После этого выберите файл ещё раз.');return;}
  try {
    const text=await file.text();
    if(token!==importReadToken)return;
    let value;
    try {value=JSON.parse(text.replace(/^\uFEFF/,''));}catch {throw new Error('Не удалось прочитать JSON. Выберите корректную резервную копию планировщика.');}
    const candidate=validateBackup(value);
    if(!currentStorageMatches())throw new Error('Данные изменились в другой вкладке. Обновите страницу перед импортом.');
    importCandidate=candidate;importBaseline=JSON.stringify(data);importNeedsNoUndo=false;
    $('no-undo-label').hidden=true;$('allow-no-undo').checked=false;$('import-error').hidden=true;
    const archived=candidate.posts.filter(p=>p.archivedAt).length;
    $('import-summary').textContent='Будет загружено: активных записей — '+(candidate.posts.length-archived)+', архивных — '+archived+'. Сейчас в планировщике: '+data.posts.length+' записей.'+(candidate.posts.length===0?' Внимание: выбранная копия пустая.':'');
    $('import-dialog').showModal();
  } catch(error) {if(token===importReadToken)dataError(error instanceof Error ? error.message : 'Файл не удалось прочитать. Текущие записи не изменены.');}
}
function showImportError(text) {$('import-error').textContent=text;$('import-error').hidden=false;}
function applyImport() {
  if(!importCandidate)return;
  try {if(importBaseline!==JSON.stringify(data) || !currentStorageMatches())throw new Error();}
  catch {showImportError('Текущие данные изменились или недоступны. Закройте диалог и обновите страницу. Импорт не выполнен.');return;}
  let oldUndo;
  try {oldUndo=localStorage.getItem(IMPORT_UNDO_KEY);}catch {showImportError('Браузер не разрешил доступ к хранилищу. Импорт не выполнен.');return;}
  const after=JSON.stringify(importCandidate);
  const snapshot={before:data,after};
  const withoutUndo=importNeedsNoUndo && $('allow-no-undo').checked;
  if(importNeedsNoUndo && !withoutUndo){showImportError('Сначала скачайте текущую копию и подтвердите замену без отмены или нажмите «Отмена».');return;}
  if(!withoutUndo){
    try {localStorage.setItem(IMPORT_UNDO_KEY,JSON.stringify(snapshot));}
    catch {
      importNeedsNoUndo=true;$('no-undo-label').hidden=false;
      showImportError('Не удалось сохранить снимок отмены: возможно, закончилось место. Данные ещё не заменены. Скачайте текущую копию. Продолжить без отмены можно только после отдельного подтверждения ниже.');return;
    }
  } else {
    try {localStorage.removeItem(IMPORT_UNDO_KEY);}catch {showImportError('Не удалось подготовить хранилище. Импорт не выполнен.');return;}
  }
  try {localStorage.setItem(STORAGE_KEY,after);}
  catch {
    try {if(oldUndo===null)localStorage.removeItem(IMPORT_UNDO_KEY);else localStorage.setItem(IMPORT_UNDO_KEY,oldUndo);}catch { /* Основной набор остался прежним, возможность отмены проверяется заново. */ }
    loadImportUndo();showImportError('Импорт не сохранён: браузер не разрешил запись или закончилось место. Ваш прежний план не изменён.');return;
  }
  data=importCandidate;importUndo=withoutUndo?null:snapshot;importCandidate=null;archiveUndoId=null;$('archive-undo').hidden=true;
  $('import-dialog').close();$('import-file').value='';
  resetLimits();renderPosts();updateDataUI();
  message(withoutUndo?'Данные заменены. Отмена этого импорта недоступна.':'Данные заменены. Последний импорт можно отменить до следующего сохранённого изменения.');
}
function undoLastImport() {
  $('data-error').hidden=true;
  if(!importUndo)return;
  try {
    if(localStorage.getItem(STORAGE_KEY)!==importUndo.after){invalidateImportUndo();dataError('После импорта данные изменились. Отмена уже недоступна.');return;}
    localStorage.setItem(STORAGE_KEY,JSON.stringify(importUndo.before));
  } catch {dataError('Не удалось отменить импорт: браузер не разрешил запись или закончилось место. Текущий план не изменён.');return;}
  data=importUndo.before;invalidateImportUndo();archiveUndoId=null;$('archive-undo').hidden=true;resetLimits();renderPosts();message('Импорт отменён. Восстановлен план, который был перед ним.');
}
const DEMO = Object.freeze({title:'Пример: почему прибыль есть, а денег нет?',date:'',time:'',status:'Идея',category:'Управленческий учёт',format:'Инструкция',notes:'Демонстрационный пример. Объяснить разницу между прибылью и движением денег на условной ситуации.',body:'Почему прибыль в отчёте ещё не означает свободные деньги на счёте?\n\nВ посте можно разобрать три причины: отсрочки клиентам, закупку запасов и погашение кредита. Завершить вопросом: какие платежи вы планируете заранее?',links:[]});
function openDemo() {
  $('demo-content').replaceChildren();$('demo-error').hidden=true;
  [['Тема',DEMO.title],['Дата','Не назначена'],['Статус',DEMO.status],['Рубрика',DEMO.category],['Формат',DEMO.format],['Заметки',DEMO.notes],['Черновик',DEMO.body]].forEach(([title,text])=>{const h=document.createElement('h3');h.textContent=title;const p=document.createElement('p');p.textContent=text;$('demo-content').append(h,p);});
  $('demo-dialog').showModal();
}
function addDemo() {
  const now=new Date().toISOString();const post={...DEMO,links:[],id:newPostId(),createdAt:now,updatedAt:now,archivedAt:null};
  if(!saveArchiveAction({...data,posts:[...data.posts,post]},$('demo-error')))return;
  $('demo-dialog').close();$('reset-filters').click();navigate('ideas');message('Пример добавлен в ваши идеи. Его можно редактировать или отправить в архив.');
}
function dismissWelcome() {
  if(saveArchiveAction({...data,settings:{...data.settings,welcomeDismissed:true}},null))updateDataUI();
}

function resetLimits() {
  listLimit = PAGE_SIZE; dayLimit = PAGE_SIZE;
  boardLimits = Object.fromEntries(CONFIG.statuses.map(s => [s, PAGE_SIZE]));
}
function dueState(post, today = localDate(new Date())) {
  if (post.archivedAt || !post.date || post.status === 'Опубликовано') return '';
  if (post.date < today) return 'overdue';
  const end = new Date(today + 'T12:00:00'); end.setDate(end.getDate() + 7);
  return post.date <= localDate(end) ? 'upcoming' : '';
}
function searchMatch(post, query) {
  const text = [post.title,post.notes,post.body,post.category,post.format,...post.links.flatMap(l => [l.label,l.url])].join('\n').toLocaleLowerCase('ru-RU');
  return text.includes(query.trim().toLocaleLowerCase('ru-RU'));
}
function filterValues() {
  return {query:$('search').value.trim(), status:$('filter-status').value, category:$('filter-category').value, format:$('filter-format').value, period:$('filter-period').value, presence:$('filter-presence').value, from:$('filter-from').value, to:$('filter-to').value};
}
function hasFilters(f) { return Boolean(f.query || f.status || f.category || f.format || f.period !== 'all' || f.presence !== 'all'); }
function filteredActive(active) {
  const f = filterValues();
  let from = '', to = '', error = '';
  if (f.period === 'custom') {
    from = f.from; to = f.to;
    if (!from || !to || !validDate(from) || !validDate(to)) error = 'Укажите начало и конец периода.';
    else if (from > to) error = 'Начало периода не может быть позже его окончания.';
  } else if (['current','next'].includes(f.period)) {
    const today = new Date(); const offset = f.period === 'next' ? 1 : 0;
    from = localDate(new Date(today.getFullYear(),today.getMonth()+offset,1));
    to = localDate(new Date(today.getFullYear(),today.getMonth()+offset+1,0));
  }
  $('custom-range').hidden = f.period !== 'custom';
  $('filter-error').textContent = error; $('filter-error').hidden = !error;
  $('filter-count').textContent = hasFilters(f) ? '· применены' : '';
  $('filter-hint').textContent = hasFilters(f) ? 'Фильтры применяются вместе. Поиск охватывает все активные записи.' : 'Поиск учитывает все записи, включая ещё не показанные.';
  if (error) return [];
  return active.filter(p => searchMatch(p,f.query) && (!f.status || p.status===f.status) && (!f.category || p.category===f.category) && (!f.format || p.format===f.format) &&
    (f.presence!=='with' || p.date) && (f.presence!=='without' || !p.date) && (!from || (p.date && p.date>=from && p.date<=to)));
}
function addMore(container, shown, total, onMore) {
  if (shown >= total) return;
  const button = document.createElement('button'); button.className='load-more'; button.textContent='Показать ещё 50';
  const info=document.createElement('p'); info.className='hint'; info.textContent='Показано '+shown+' из '+total;
  button.addEventListener('click',onMore); container.append(info,button);
}

function localDate(d) { return [String(d.getFullYear()).padStart(4,'0'), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-'); }
function newPostId() {
  // randomUUID недоступен при открытии с телефона по обычному HTTP в локальной сети.
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function displayDate(value) { return value ? value.split('-').reverse().join('.') : 'Без даты'; }
function sortedPosts(posts) {
  return [...posts].sort((a,b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99') || (a.time || '99:99').localeCompare(b.time || '99:99') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

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
      data = validateBackup(JSON.parse(raw));
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
  const post = {...values, id: previous?.id || newPostId(), createdAt:previous?.createdAt || now, updatedAt:now, archivedAt:previous?.archivedAt || null};
  const next = {...data, posts: previous ? data.posts.map(p => p.id === post.id ? post : p) : [...data.posts, post]};
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
  catch {
    saveDraft(); formError('Публикация не сохранена: браузер не разрешил запись или закончилось место. Введённый текст остаётся в форме.'); return false;
  }
  data = next; invalidateImportUndo(); const removed = clearDraft(); closeEditor(); renderPosts();
  if (removed) message('Публикация сохранена в этом браузере.');
  return true;
}
function postCard(post, compact = false) {
    const button = document.createElement('button'); button.className = compact ? 'post-card compact-card' : 'post-card';
    button.dataset.postId = post.id;
    const status = document.createElement('span'); status.className = 'status'; status.textContent = post.status;
    const title = document.createElement('strong'); title.textContent = post.title;
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = [displayDate(post.date), post.time, post.category].filter(Boolean).join(' · ');
    button.append(status,title,meta); button.addEventListener('click', () => viewPost(post.id));
    const due = dueState(post);
    if(due){const label=document.createElement('span');label.className='due-label '+due;label.textContent=due==='overdue'?'Просрочено':'Ближайшая';button.append(label);}
    button.draggable = !post.archivedAt;
    button.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-planner-post', post.id); e.dataTransfer.effectAllowed = 'move'; });
    return button;
}
function dropTarget(element, field, value) {
  element.addEventListener('dragover', e => {
    if (!Array.from(e.dataTransfer.types).includes('application/x-planner-post')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; element.classList.add('drop-target');
  });
  element.addEventListener('dragleave', () => element.classList.remove('drop-target'));
  element.addEventListener('drop', e => {
    e.preventDefault(); element.classList.remove('drop-target');
    const post = data.posts.find(p => p.id === e.dataTransfer.getData('application/x-planner-post') && !p.archivedAt);
    if (post && post[field] !== value) openChange(post.id,field,value);
  });
}
function renderPosts() {
  const active = sortedPosts(data.posts.filter(p => !p.archivedAt));
  renderedToday = localDate(new Date());
  $('count-ideas').textContent=active.filter(p=>!p.date).length;
  $('count-upcoming').textContent=active.filter(p=>dueState(p)==='upcoming').length;
  $('count-overdue').textContent=active.filter(p=>dueState(p)==='overdue').length;
  const filtered = filteredActive(active);
  const archive = currentSection === 'archive';
  const f = filterValues();
  const posts = archive ? data.posts.filter(p=>p.archivedAt && searchMatch(p,$('archive-search').value)).sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt)||a.id.localeCompare(b.id)) :
    filtered.filter(p => currentSection === 'ideas' ? !p.date : (hasFilters(f) || p.date));
  $('posts').replaceChildren(); $('ideas-shortcut').replaceChildren();$('list-more').replaceChildren();
  $('calendar-grid').replaceChildren();$('day-posts').replaceChildren();$('board').replaceChildren();$('board-tabs').replaceChildren();
  $('list-title').textContent = archive ? 'Архивные публикации' : currentSection === 'ideas' ? 'Идеи без даты' : hasFilters(f) ? 'Результаты поиска и фильтров' : 'Публикации по датам';
  $('post-count').textContent = posts.length; $('empty').hidden = posts.length > 0;
  const searching=archive ? Boolean($('archive-search').value.trim()) : hasFilters(f);
  $('empty-title').textContent = searching ? 'Ничего не найдено' : archive ? 'В архиве пока пусто' : currentSection === 'ideas' ? 'Место для новых идей' : 'План пока свободен';
  $('empty-text').textContent = searching ? 'Измените запрос или сбросьте фильтры.' : archive ? 'Здесь будут записи, которые вы уберёте из активного плана. Их можно восстановить.' : currentSection === 'ideas' ? 'Сохраните тему сейчас, а день публикации выберите позже.' : 'Добавьте публикацию с датой или назначьте дату сохранённой идее.';
  $('empty-create').hidden=archive || searching;$('archive-help').hidden=!archive || searching;
  if (currentSection === 'plan') {
    const shortcut = document.createElement('button'); shortcut.className = 'ideas-link';
    shortcut.textContent = 'Идеи без даты: ' + active.filter(p=>!p.date).length;
    shortcut.addEventListener('click',()=>navigate('ideas')); $('ideas-shortcut').append(shortcut);
  }
  let group;
  let lastDate = null;
  if(['plan','ideas','archive'].includes(currentSection)) posts.slice(0,listLimit).forEach(post => {
    if ((!archive && lastDate !== post.date) || !group) {
      const heading = document.createElement('h3'); heading.className = 'date-heading'; heading.textContent = displayDate(post.date);
      group = document.createElement('div'); group.className = 'cards';
      if (!archive && (post.date || hasFilters(f))) $('posts').append(heading);
      $('posts').append(group); lastDate = post.date;
    }
    group.append(postCard(post));
  });
  if(['plan','ideas','archive'].includes(currentSection)) addMore($('list-more'),Math.min(listLimit,posts.length),posts.length,()=>{listLimit+=PAGE_SIZE;renderPosts();});
  if(currentSection==='calendar')renderCalendar(filtered);
  if(currentSection==='statuses')renderBoard(filtered);
}
function createForDate(date) { openEditor({date}); }
function renderCalendar(posts) {
  $('calendar-grid').replaceChildren();
  $('month-title').textContent = calendarMonth.toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
  const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth();
  const offset = (calendarMonth.getDay()+6)%7;
  const days = new Date(year,month+1,0).getDate();
  for (let i=0;i<offset;i++) { const blank = document.createElement('div'); blank.className='calendar-blank'; $('calendar-grid').append(blank); }
  for (let day=1;day<=days;day++) {
    const date = localDate(new Date(year,month,day));
    const dayPosts = posts.filter(p=>p.date===date);
    const cell = document.createElement('div'); cell.className='calendar-day'; cell.dataset.date=date;
    if(date === selectedDay) cell.classList.add('selected');
    if(date === localDate(new Date())) cell.classList.add('today');
    const choose = document.createElement('button'); choose.className='day-number'; choose.textContent=day;
    choose.setAttribute('aria-label',displayDate(date) + ', публикаций: ' + dayPosts.length);
    choose.setAttribute('aria-pressed',String(date===selectedDay));
    // При действующих фильтрах пустой результат дня не означает отсутствие записей.
    choose.addEventListener('click',()=>{selectedDay=date;dayLimit=PAGE_SIZE;renderCalendar(posts);if(!data.posts.some(p=>!p.archivedAt && p.date===date))createForDate(date);});
    cell.append(choose);
    const count = document.createElement('span'); count.className='day-count';count.textContent=dayPosts.length ? dayPosts.length : ''; cell.append(count);
    const dayCards = document.createElement('div');dayCards.className='calendar-cards';
    dayPosts.slice(0,3).forEach(p=>dayCards.append(postCard(p,true)));
    if(dayPosts.length>3){const more=document.createElement('button');more.className='more-day';more.textContent='Ещё '+(dayPosts.length-3);more.addEventListener('click',()=>{selectedDay=date;dayLimit=PAGE_SIZE;renderCalendar(posts);$('day-title').scrollIntoView({block:'nearest'});});dayCards.append(more);}
    if(dayPosts.some(p=>dueState(p)==='overdue')){const flag=document.createElement('span');flag.className='day-overdue';flag.textContent='!';flag.setAttribute('aria-label','Есть просроченные публикации');cell.append(flag);}
    cell.append(dayCards);dropTarget(cell,'date',date);$('calendar-grid').append(cell);
  }
  $('day-title').textContent='Публикации на '+displayDate(selectedDay);
  $('day-posts').replaceChildren();
  const selectedPosts=posts.filter(p=>p.date===selectedDay);
  selectedPosts.slice(0,dayLimit).forEach(p=>$('day-posts').append(postCard(p)));
  addMore($('day-posts'),Math.min(dayLimit,selectedPosts.length),selectedPosts.length,()=>{dayLimit+=PAGE_SIZE;renderCalendar(posts);});
  if(!selectedPosts.length){const hint=document.createElement('p');hint.className='hint';hint.textContent='На этот день публикаций пока нет.';$('day-posts').append(hint);}
}
function renderBoard(posts) {
  $('board').replaceChildren();$('board-tabs').replaceChildren();
  CONFIG.statuses.forEach(status=>{
    const items=posts.filter(p=>p.status===status);
    const tab=document.createElement('button');tab.textContent=status+' · '+items.length;tab.setAttribute('aria-pressed',String(status===boardStatus));
    tab.addEventListener('click',()=>{boardStatus=status;renderBoard(posts);});$('board-tabs').append(tab);
    const column=document.createElement('section');column.className='board-column';column.dataset.status=status;column.classList.toggle('active-column',status===boardStatus);
    const heading=document.createElement('h2');heading.textContent=status+' · '+items.length;column.append(heading);
    items.slice(0,boardLimits[status]).forEach(p=>column.append(postCard(p)));
    addMore(column,Math.min(boardLimits[status],items.length),items.length,()=>{boardLimits[status]+=PAGE_SIZE;renderBoard(posts);});
    if(!items.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='Публикаций пока нет.';column.append(empty);}
    dropTarget(column,'status',status);$('board').append(column);
  });
}
function openChange(id,field,value) {
  const post=data.posts.find(p=>p.id===id);if(!post)return;
  changeRequest={id,field};$('change-title').textContent=field==='date'?'Изменить дату':'Изменить статус';
  $('change-summary').textContent=post.title+' · Сейчас: '+(field==='date'?displayDate(post.date):post.status);
  $('change-date-label').hidden=field!=='date';$('change-status-label').hidden=field!=='status';
  $('new-date').value=field==='date'?(value ?? post.date):'';
  $('new-status').value=field==='status'?(value ?? post.status):'Идея';
  $('confirm-change').textContent=field==='date'?'Перенести':'Изменить статус';
  $('change-error').hidden=true;$('change-dialog').showModal();
}
function applyChange() {
  if(!changeRequest)return;
  const {id,field}=changeRequest;
  const value=field==='date'?$('new-date').value:$('new-status').value;
  if((field==='date' && value && !validDate(value)) || (field==='status' && !CONFIG.statuses.includes(value)))return;
  const previous=data.posts.find(p=>p.id===id);if(!previous)return;
  const updated={...previous,[field]:value,updatedAt:new Date().toISOString()};
  if(field==='date' && !value)updated.time='';
  const next={...data,posts:data.posts.map(p=>p.id===id?updated:p)};
  try {if(storageBlocked)throw new Error('Недоступно');localStorage.setItem(STORAGE_KEY,JSON.stringify(next));}
  catch{$('change-error').textContent='Изменение не сохранено. Браузер не разрешил запись или закончилось место. Прежние данные сохранены.';$('change-error').hidden=false;return;}
  data=next;invalidateImportUndo();$('change-dialog').close();changeRequest=null;
  if(field==='date' && value){selectedDay=value;calendarMonth=new Date(value+'T12:00:00');calendarMonth.setDate(1);}
  renderPosts();message('Изменение сохранено в этом браузере.');
  if($('viewer').open)viewPost(id);
}
function viewPost(id) {
  const post = data.posts.find(p => p.id === id); if (!post) return;
  $('view-error').hidden=true;
  ['edit-post','change-date','change-status','archive-post'].forEach(key=>$(key).hidden=Boolean(post.archivedAt));
  ['restore-post','delete-post'].forEach(key=>$(key).hidden=!post.archivedAt);
  viewedId = id; $('viewer-title').textContent = post.title; $('view-content').replaceChildren();
  [['Статус',post.status],['Плановая дата',post.date ? post.date.split('-').reverse().join('.') : 'Не назначена'],['Время',post.time],['Рубрика',post.category],['Формат',post.format],['Заметки',post.notes],['Черновик',post.body]].forEach(([name,value]) => {
    if (!value) return;
    const heading = document.createElement('h3'); heading.textContent = name;
    const text = document.createElement('p'); text.textContent = value; $('view-content').append(heading,text);
  });
  post.links.forEach(link => { const a = document.createElement('a'); a.textContent = link.label || link.url; a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('view-content').append(a); });
  if(!$('viewer').open)$('viewer').showModal();
}
// Сначала записываем целиком новое состояние. При отказе хранилища состояние в памяти не меняется.
function saveArchiveAction(next, errorElement) {
  try { if(storageBlocked)throw new Error('Недоступно'); localStorage.setItem(STORAGE_KEY,JSON.stringify(next)); }
  catch {
    const text='Изменение не сохранено: браузер не разрешил запись или закончилось место. Прежние данные сохранены.';
    if(errorElement){errorElement.textContent=text;errorElement.hidden=false;}else message(text,true);
    return false;
  }
  data=next;invalidateImportUndo();return true;
}
function archivePost() {
  const post=data.posts.find(p=>p.id===viewedId && !p.archivedAt);if(!post)return;
  const now=new Date().toISOString();
  const next={...data,posts:data.posts.map(p=>p.id===post.id?{...p,archivedAt:now,updatedAt:now}:p)};
  if(!saveArchiveAction(next,$('view-error')))return;
  archiveUndoId=post.id;$('archive-undo').hidden=false;$('viewer').close();renderPosts();message('Публикация перемещена в архив. Её можно восстановить.');
}
function restorePost(id, undo=false) {
  const post=data.posts.find(p=>p.id===id && p.archivedAt);if(!post)return;
  const next={...data,posts:data.posts.map(p=>p.id===id?{...p,archivedAt:null,updatedAt:new Date().toISOString()}:p)};
  if(!saveArchiveAction(next,undo?null:$('view-error')))return;
  if(archiveUndoId===id){archiveUndoId=null;$('archive-undo').hidden=true;}
  if($('viewer').open)$('viewer').close();renderPosts();message('Публикация восстановлена с прежними полями и статусом.');
}
function requestDelete() {
  const post=data.posts.find(p=>p.id===viewedId && p.archivedAt);if(!post)return;
  deleteId=post.id;$('delete-summary').textContent=post.title;$('delete-error').hidden=true;$('delete-dialog').showModal();
}
function confirmDelete() {
  const post=data.posts.find(p=>p.id===deleteId && p.archivedAt);if(!post)return;
  if(!saveArchiveAction({...data,posts:data.posts.filter(p=>p.id!==deleteId)},$('delete-error')))return;
  if(archiveUndoId===deleteId){archiveUndoId=null;$('archive-undo').hidden=true;}
  deleteId=null;$('delete-dialog').close();$('viewer').close();renderPosts();message('Архивная запись удалена навсегда.');
}
const sections = {plan:'Мой план',calendar:'Календарь',ideas:'Идеи',statuses:'Статусы',more:'Ещё',archive:'Архив',help:'Справка',data:'Данные и резервная копия'};
function navigate(section) {
  currentSection = section;resetLimits();
  $('page-title').textContent = sections[section];
  document.querySelectorAll('[data-section]').forEach(b => { b.removeAttribute('aria-current'); if (b.dataset.section === section) b.setAttribute('aria-current','page'); });
  $('posts-section').hidden = !['plan','ideas','archive'].includes(section); $('more-menu').hidden = section !== 'more';
  $('help-section').hidden=section!=='help';$('data-section').hidden=section!=='data';
  $('calendar-section').hidden=section!=='calendar';$('board-section').hidden=section!=='statuses';
  $('filter-panel').hidden=!['plan','ideas','calendar','statuses'].includes(section);$('summary').hidden=section!=='plan';$('archive-search-panel').hidden=section!=='archive';
  $('page-subtitle').textContent = {plan:'Публикации по датам. Поиск и фильтры охватывают также идеи без даты.',ideas:'Сначала мысль, потом дата. Здесь все записи без дня публикации.',calendar:'Ваш контент в ритме месяца.',statuses:'От первой идеи до опубликованного поста.',archive:'Записи вне активного плана. Их можно восстановить.'}[section] || 'Дополнительные разделы планировщика.';
  renderPosts();updateDataUI();
}
// Импорт и экспорт выполняются локально. Файлы не отправляются по сети.
$('export-data').addEventListener('click',downloadBackup);$('export-before-import').addEventListener('click',downloadBackup);
$('import-file').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';readImport(file);});
$('confirm-import').addEventListener('click',applyImport);
$('cancel-import').addEventListener('click',()=>{importCandidate=null;++importReadToken;$('import-dialog').close();});
$('import-dialog').addEventListener('cancel',()=>{importCandidate=null;++importReadToken;});
$('undo-import').addEventListener('click',undoLastImport);
$('welcome-example').addEventListener('click',openDemo);$('help-example').addEventListener('click',openDemo);
$('welcome-help').addEventListener('click',()=>navigate('help'));$('dismiss-welcome').addEventListener('click',dismissWelcome);
$('close-demo').addEventListener('click',()=>$('demo-dialog').close());$('add-demo').addEventListener('click',addDemo);
fillSelect('status', CONFIG.statuses, false); fillSelect('category', CONFIG.categories, true); fillSelect('format', CONFIG.formats, true);
fillSelect('new-status',CONFIG.statuses,false);
fillSelect('filter-status',CONFIG.statuses,true);fillSelect('filter-category',CONFIG.categories,true);fillSelect('filter-format',CONFIG.formats,true);
['filter-status','filter-category','filter-format'].forEach(id=>$(id).options[0].textContent='Все');
['search','filter-from','filter-to'].forEach(id=>$(id).addEventListener('input',()=>{resetLimits();renderPosts();}));
['filter-status','filter-category','filter-format','filter-period','filter-presence'].forEach(id=>$(id).addEventListener('change',()=>{resetLimits();renderPosts();}));
$('clear-search').addEventListener('click',()=>{$('search').value='';resetLimits();renderPosts();$('search').focus();});
$('reset-filters').addEventListener('click',()=>{['search','filter-status','filter-category','filter-format','filter-from','filter-to'].forEach(id=>$(id).value='');$('filter-period').value='all';$('filter-presence').value='all';resetLimits();renderPosts();});
$('archive-search').addEventListener('input',()=>{listLimit=PAGE_SIZE;renderPosts();});
$('clear-archive-search').addEventListener('click',()=>{$('archive-search').value='';listLimit=PAGE_SIZE;renderPosts();});
$('archive-help').addEventListener('click',()=>navigate('help'));
$('archive-post').addEventListener('click',archivePost);$('restore-post').addEventListener('click',()=>restorePost(viewedId));
$('undo-archive').addEventListener('click',()=>restorePost(archiveUndoId,true));
$('delete-post').addEventListener('click',requestDelete);$('confirm-delete').addEventListener('click',confirmDelete);
$('cancel-delete').addEventListener('click',()=>{$('delete-dialog').close();deleteId=null;});
$('change-date').addEventListener('click',()=>openChange(viewedId,'date'));
$('change-status').addEventListener('click',()=>openChange(viewedId,'status'));
$('cancel-change').addEventListener('click',()=>{$('change-dialog').close();changeRequest=null;});
$('change-form').addEventListener('submit',e=>{e.preventDefault();applyChange();});
function shiftMonth(amount) {calendarMonth=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+amount,1);selectedDay=localDate(calendarMonth);dayLimit=PAGE_SIZE;renderPosts();}
$('prev-month').addEventListener('click',()=>shiftMonth(-1));$('next-month').addEventListener('click',()=>shiftMonth(1));
$('calendar-today').addEventListener('click',()=>{const now=new Date();calendarMonth=new Date(now.getFullYear(),now.getMonth(),1);selectedDay=localDate(now);dayLimit=PAGE_SIZE;renderPosts();});
$('day-create').addEventListener('click',()=>createForDate(selectedDay));
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
function refreshDay() {if(localDate(new Date())!==renderedToday)renderPosts();}
setInterval(refreshDay,60000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshDay();});
loadData(); loadImportUndo(); renderPosts();
