const $ = id => document.getElementById(id);
const format = n => { const units = ['B','KiB','MiB','GiB','TiB']; let i=0; while(n>=1024&&i<4){n/=1024;i++;} return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; };
const delay = ms => new Promise(r => setTimeout(r,ms));
let entries=[], running=false, paused=false, cancelled=false, collection=null, started=0, pausedAt=0, active=new Set();
async function api(route, options={}) {
  const response=await fetch(route,options);
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'요청 실패');
  return data;
}
const post = (route, data) => api(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function message(text=''){ $('message').textContent=text; }
function row(entry) {
  const element=document.createElement('div');element.className='row';
  const icon=document.createElement('div');icon.className='file-icon';icon.textContent='FILE';
  const info=document.createElement('div');info.className='file-info';
  const name=document.createElement('div');name.className='file-name';name.textContent=entry.path;
  const meta=document.createElement('div');meta.className='file-meta';meta.textContent=format(entry.size);
  const track=document.createElement('div');track.className='mini-track';const bar=document.createElement('div');track.append(bar);
  const action=document.createElement('div');action.className='file-action';action.textContent='대기 중';
  info.append(name,meta,track);element.append(icon,info,action);$('file-list').append(element);
  Object.assign(entry,{bar,action,meta});
  if(entry.url) finished(entry);
}
function finished(entry){entry.state='done';entry.sent=entry.size;entry.bar.style.width='100%';entry.action.replaceChildren();const link=document.createElement('a');link.href=entry.url;link.textContent='다운로드 ↗';link.target='_blank';link.rel='noopener';entry.action.append(link);const copy=document.createElement('button');copy.className='text-button';copy.textContent='URL 복사';copy.onclick=()=>copyText(entry.url);entry.action.append(document.createElement('br'),copy);}
function add(files){
  if(running||collection)return message('현재 업로드를 마치거나 취소한 후 새 파일을 선택하세요.');
  for(const file of files){const path=file.uploadPath||file.webkitRelativePath||file.name;if(entries.some(e=>e.path===path))continue;entries.push({file,path,size:file.size,sent:0,state:'pending',parts:[],upload:null});}
  $('file-list').replaceChildren();entries.forEach(row);$('selection').textContent=`${entries.length.toLocaleString()}개 파일 · ${format(entries.reduce((n,e)=>n+e.size,0))}`;
  $('progress-panel').hidden=!entries.length;$('clear').hidden=!entries.length;render();
}
function render(){
  const total=entries.reduce((n,e)=>n+e.size,0),sent=entries.reduce((n,e)=>n+e.sent,0);
  const done=entries.filter(e=>e.state==='done').length;
  const percent=total?Math.min(100,sent/total*100):(done===entries.length&&entries.length?100:0);
  $('percent').textContent=`${percent.toFixed(1)}%`;$('overall-bar').style.width=`${percent}%`;$('bytes').textContent=`${format(sent)} / ${format(total)}`;
  const elapsed=(Date.now()-started)/1000,speed=started&&elapsed>0?sent/elapsed:0;
  $('speed').textContent=running&&!paused?`${format(speed)}/s`: '—';
  $('eta').textContent=speed&&sent<total?`약 ${Math.ceil((total-sent)/speed/60)}분 남음`:'—';
  if(running)$('status').textContent=cancelled?'취소 중':paused?'일시정지':`업로드 중 · ${done}/${entries.length}개 완료`;
}
async function ready(){while(paused&&!cancelled)await delay(200);if(cancelled)throw Error('업로드 취소됨');}
function endpoint(e){return `/api/upload?${new URLSearchParams({key:e.upload.key,uploadId:e.upload.uploadId})}`;}
function sendPart(e,number,blob){return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();active.add(xhr);xhr.open('PUT',`${endpoint(e)}&partNumber=${number}`);xhr.setRequestHeader('Content-Type','application/octet-stream');
  xhr.upload.onprogress=event=>{e.sent=e.committed+event.loaded;e.bar.style.width=`${e.size?e.sent/e.size*100:0}%`;render();};
  const cleanup=()=>active.delete(xhr);
  xhr.onload=()=>{cleanup();let data;try{data=JSON.parse(xhr.responseText);}catch{reject(Error('서버 응답 오류'));return;}if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(Error(data.error||`HTTP ${xhr.status}`));};
  xhr.onerror=()=>{cleanup();reject(Error('네트워크 연결 실패'));};xhr.onabort=()=>{cleanup();reject(Error('전송 중단'));};xhr.send(blob);
});}
async function retry(task){for(let attempt=0;attempt<5;attempt++){await ready();try{return await task();}catch(error){if(cancelled)throw error;if(attempt===4)throw error;await delay(Math.min(1000*2**attempt,10000));}}}
async function upload(e){
  e.state='uploading';e.action.textContent='업로드 중';
  if(!e.upload)e.upload=await post('/api/uploads',{prefix:collection.prefix,path:e.path,size:e.size,type:e.file.type,storage:$('storage').value});
  if(e.upload.empty){e.url=e.upload.url;finished(e);render();return;}
  const size=e.upload.partSize;
  for(let number=e.parts.length+1;number<=Math.ceil(e.size/size);number++){
    await ready();e.committed=(number-1)*size;e.sent=e.committed;
    const blob=e.file.slice(e.committed,Math.min(number*size,e.size));
    const part=await retry(()=>sendPart(e,number,blob));e.parts.push(part);e.sent=e.committed+blob.size;
  }
  await ready();e.action.textContent='완료 처리 중';const result=await retry(()=>post(endpoint(e),{parts:e.parts}));e.url=result.url;finished(e);render();
}
async function start(){
  if(running)return;message();running=true;cancelled=false;paused=false;started=Date.now();$('start').hidden=true;$('pause').hidden=false;$('cancel').hidden=false;$('clear').hidden=true;$('pause').textContent='일시정지';
  try{
    if(!collection){collection=await post('/api/collection',{});collection.shareUrl=location.origin+'/share/'+collection.prefix;}
    let index=0;await Promise.all(Array.from({length:Math.min(3,entries.length)},async()=>{while(index<entries.length&&!cancelled){const e=entries[index++];if(e.state==='done')continue;try{await upload(e);}catch(error){e.state=cancelled?'cancelled':'error';e.sent=Math.min(e.size,e.parts.length*(e.upload?.partSize||0));e.action.textContent=cancelled?'취소됨':'실패';e.meta.textContent=`${format(e.size)} · ${error.message}`;}}}));
    const completed=entries.filter(e=>e.state==='done').length;
    $('status').textContent=cancelled?'업로드 취소됨':completed===entries.length?'모든 파일 업로드 완료':`${completed}/${entries.length}개 완료 · 실패한 파일은 다시 시도할 수 있습니다`;
    if(completed){$('share-result').hidden=false;$('share-link').href=collection.shareUrl;$('share-link').textContent=collection.shareUrl;}
  }catch(error){message(error.message);}finally{running=false;render();$('pause').hidden=true;$('cancel').hidden=true;$('start').hidden=entries.every(e=>e.state==='done')||cancelled;$('start').textContent='실패한 파일 다시 시도';$('clear').hidden=false;}
}
$('start').onclick=start;
$('pause').onclick=()=>{paused=!paused;if(paused)pausedAt=Date.now();else started+=Date.now()-pausedAt;$('pause').textContent=paused?'업로드 계속':'일시정지';render();};
$('cancel').onclick=async()=>{cancelled=true;paused=false;active.forEach(xhr=>xhr.abort());$('cancel').disabled=true;while(running)await delay(200);await Promise.allSettled(entries.filter(e=>e.upload?.uploadId&&e.state!=='done').map(e=>api(endpoint(e),{method:'DELETE'})));$('cancel').disabled=false;};
$('clear').onclick=()=>{if(running)return;entries=[];collection=null;started=0;$('file-list').replaceChildren();$('progress-panel').hidden=true;$('share-result').hidden=true;$('clear').hidden=true;$('start').hidden=false;$('start').textContent='업로드 시작 ↗';$('selection').textContent='선택한 파일이 없습니다';$('files').value='';$('folder').value='';message();};
$('files').onchange=e=>add(e.target.files);$('folder').onchange=e=>add(e.target.files);
async function traverse(item,root='',files=[]){
  if(item.isFile){
    const file=await new Promise((resolve,reject)=>item.file(resolve,reject));
    file.uploadPath=root+file.name;files.push(file);return;
  }
  if(!item.isDirectory)return;
  const reader=item.createReader();
  while(true){
    const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
    if(!batch.length)break;
    for(const child of batch)await traverse(child,root+item.name+'/',files);
  }
}
const dropZone=$('drop');
// Capture drops across the page, including drops on native file inputs.
// Some browsers omit the Files type during dragging, so do not depend on it.
window.addEventListener('dragover',e=>{
  e.preventDefault();
  if(e.dataTransfer)e.dataTransfer.dropEffect='copy';
  if(!$('upload-view').hidden)dropZone.classList.add('dragover');
},true);
window.addEventListener('dragleave',e=>{
  if(!e.relatedTarget)dropZone.classList.remove('dragover');
},true);
window.addEventListener('drop',async e=>{
  e.preventDefault();e.stopPropagation();dropZone.classList.remove('dragover');
  if($('upload-view').hidden)return;
  if(running||collection)return message('현재 업로드를 마치거나 취소한 후 새 파일을 선택하세요.');
  // Capture entries and files before awaiting: drag data is only available during this event.
  const items=Array.from(e.dataTransfer?.items||[]).filter(item=>item.kind==='file').map(item=>({
    entry:item.webkitGetAsEntry?.()||item.getAsEntry?.(),file:item.getAsFile()
  }));
  const fallback=Array.from(e.dataTransfer?.files||[]);
  try{
    const files=[];message('파일 및 폴더를 확인하고 있습니다.');
    if(items.length){
      for(const item of items){
        if(item.entry)await traverse(item.entry,'',files);
        else if(item.file)files.push(item.file);
      }
    }else for(const file of fallback)files.push(file);
    if(!files.length)return message('추가할 파일이 없습니다. 빈 폴더는 업로드하지 않습니다.');
    message();add(files);
  }catch(error){message('파일 및 폴더를 읽지 못했습니다: '+error.message);}
},true);
async function copyText(value){try{await navigator.clipboard.writeText(value);message('링크를 복사했습니다.');}catch{message('복사하지 못했습니다. 표시된 URL을 직접 복사하세요.');}}
$('copy-share').onclick=()=>copyText(collection.shareUrl);
$('download-links').onclick=()=>{const text=entries.filter(e=>e.url).map(e=>`${e.path}\t${e.url}`).join('\n');const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='backup-links.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener('beforeunload',e=>{if(running){e.preventDefault();e.returnValue='';}});
async function shared(){if(!location.pathname.startsWith('/share/'))return;$('upload-view').hidden=true;$('shared-view').hidden=false;document.querySelector('h1').textContent='파일이 도착했어요.';document.querySelector('.intro').textContent='업로드된 파일을 다운로드하세요. 파일은 언제든 삭제될 수 있으며 보관 기간은 보장되지 않습니다.';const root=decodeURIComponent(location.pathname.slice(7));let cursor=null,count=0;try{do{const data=await api(`/api/files?${new URLSearchParams({prefix:root,...(cursor?{cursor}:{})})}`);for(const file of data.files){row({path:file.name,size:file.size,url:file.url});count++;}cursor=data.cursor;}while(cursor);$('shared-status').textContent=count?`${count.toLocaleString()}개 파일 · 각 파일의 다운로드 버튼을 눌러 저장하세요.`:'완료된 파일이 없습니다. 업로드 중이거나 보관 기간이 지났을 수 있습니다.';}catch(error){$('shared-status').textContent=error.message;}}
shared();
