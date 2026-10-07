const $ = id => document.getElementById(id);
const format = n => { const units = ['B','KiB','MiB','GiB','TiB']; let i=0; while(n>=1024&&i<4){n/=1024;i++;} return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; };
const delay = ms => new Promise(r => setTimeout(r,ms));
let entries=[], cleaning=false, cleanupFailed=false, cleanupMode=null, uploadLocked=false, running=false, paused=false, cancelled=false, collection=null, started=0, pausedAt=0, active=new Set();
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
function finished(entry){entry.state='done';entry.sent=entry.size;entry.bar.style.width='100%';entry.action.replaceChildren();if(!location.pathname.startsWith('/share/')){entry.action.textContent='완료';return;}const link=document.createElement('a');link.href=entry.url;link.textContent='다운로드 ↗';link.target='_blank';link.rel='noopener';entry.action.append(link);const copy=document.createElement('button');copy.className='text-button';copy.textContent='URL 복사';copy.onclick=()=>copyText(entry.url);entry.action.append(document.createElement('br'),copy);}
function add(files){
  if(uploadLocked)return message('업로드 시작 이후에는 파일이나 폴더를 추가할 수 없습니다.');
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
function endpoint(e){return `/api/upload?${new URLSearchParams({storage:collection.storage,key:e.upload.key,uploadId:e.upload.uploadId})}`;}
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
  if(!e.upload)e.upload=await post('/api/uploads',{prefix:collection.prefix,path:e.path,size:e.size,type:e.file.type,storage:collection.storage});
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
  if(running||cleaning||!entries.length)return;if(!$('storage').value)return message('저장소 정보를 불러온 후 다시 시도하세요.');message();running=true;cancelled=false;paused=false;started=Date.now();$('start').hidden=true;$('pause').hidden=false;$('cancel').hidden=false;$('clear').hidden=true;$('pause').textContent='일시정지';
  uploadLocked=true;$('files').disabled=true;$('folder').disabled=true;$('storage').disabled=true;$('drop').hidden=true;$('upload-notice').hidden=false;$('upload-again').hidden=true;
  $('upload-notice-title').textContent='업로드 중입니다.';
  $('upload-notice-message').textContent='업로드 완료 전까지 새로고침하지 말고 완료를 기다려 주세요. 업로드 시작 이후에는 파일이나 폴더를 추가할 수 없습니다.';
  try{
    if(!collection){collection=await post('/api/collection',{storage:$('storage').value});collection.shareUrl=location.origin+'/share/'+collection.storage+'/'+collection.prefix;}
    showCompletedLinks();
    let index=0;await Promise.all(Array.from({length:Math.min(3,entries.length)},async()=>{while(index<entries.length&&!cancelled){const e=entries[index++];if(e.state==='done')continue;try{await upload(e);}catch(error){e.state=cancelled?'cancelled':'error';e.sent=Math.min(e.size,e.parts.length*(e.upload?.partSize||0));e.action.textContent=cancelled?'취소됨':'실패';e.meta.textContent=`${format(e.size)} · ${error.message}`;}}}));
    const completed=entries.filter(e=>e.state==='done').length;
    $('status').textContent=cancelled?'업로드 취소됨':completed===entries.length?'모든 파일 업로드 완료':`${completed}/${entries.length}개 완료 · 실패한 파일은 다시 시도할 수 있습니다`;
    if(completed)showCompletedLinks();
  }catch(error){message(error.message);}finally{running=false;render();$('pause').hidden=true;$('cancel').hidden=true;$('start').hidden=entries.every(e=>e.state==='done')||cancelled;$('start').textContent='실패한 파일 다시 시도';$('clear').hidden=true;
    const allDone=entries.length>0&&entries.every(e=>e.state==='done');
    $('upload-again').hidden=!allDone||cleaning;
    $('upload-notice-title').textContent=allDone?'업로드가 완료됐어요.':cancelled?'업로드가 취소되었습니다.':'업로드를 완료하지 못했습니다.';
    $('upload-notice-message').textContent=allDone?'공유 링크에서 업로드한 파일을 확인할 수 있습니다.':cancelled?'완료된 파일은 공유 링크에서 확인할 수 있습니다.':'새로고침하지 말고 실패한 파일 다시 시도 버튼을 눌러 업로드를 완료해 주세요. 파일 추가는 할 수 없습니다.';
  }
}
$('start').onclick=start;
$('pause').onclick=()=>{paused=!paused;if(paused)pausedAt=Date.now();else started+=Date.now()-pausedAt;$('pause').textContent=paused?'업로드 계속':'일시정지';render();};
$('cancel').onclick=()=>{ $('cancel-options').hidden=false; };
$('cancel-back').onclick=()=>{ $('cancel-options').hidden=true; };
$('cancel-delete').onclick=()=>cancelUpload(true);
$('cancel-keep').onclick=()=>cancelUpload(false);
async function cancelUpload(removeFiles){
  if(cleaning)return;
  if(cleanupFailed&&cleanupMode!==removeFiles)return message('실패한 정리는 이전과 같은 옵션으로 다시 시도하세요.');
  cleanupMode=removeFiles;
  cleaning=true;cleanupFailed=false;cancelled=true;paused=false;
  $('cancel-options').hidden=true;$('cancel').disabled=true;
  $('cancel-delete').disabled=true;$('cancel-keep').disabled=true;
  $('clear').hidden=true;$('upload-again').hidden=true;
  $('cleanup-status').hidden=false;$('cleanup-status').textContent='전송을 중단하고 있습니다.';
  active.forEach(xhr=>xhr.abort());
  while(running)await delay(100);
  let next=0,processed=0,deleted=0,failed=0;
  const candidates=entries.filter(e=>!e.cleaned);
  await Promise.all(Array.from({length:Math.min(3,candidates.length)},async()=>{
    while(next<candidates.length){
      const entry=candidates[next++];
      try{
        if(entry.upload?.uploadId&&entry.state!=='done'){
          try{await api(endpoint(entry),{method:'DELETE'});}
          catch(error){
            // Completion may have succeeded even if its response was lost.
            if(!removeFiles)throw error;
          }
        }
        entry.action.textContent=entry.state==='done'?'유지됨':'취소됨';
        entry.cleaned=true;
      }catch(error){failed++;entry.action.textContent='정리 실패';entry.meta.textContent=error.message;}
      processed++;
      $('cleanup-status').textContent=removeFiles?`폴더 삭제 준비 중 · 진행 중인 전송 ${processed}/${candidates.length}개 정리`:`업로드 취소 중 · ${processed}/${candidates.length}개 처리 · ${failed}개 실패`;
    }
  }));
  if(removeFiles&&collection){
    try{
      let hasMore;
      do{
        $('cleanup-status').textContent=`업로드 폴더 전체 삭제 중 · ${deleted}개 객체 정리됨`;
        const result=await api('/api/collection',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({storage:collection.storage,prefix:collection.prefix,deleteToken:collection.deleteToken})});
        deleted+=result.deleted;hasMore=result.hasMore;
        $('cleanup-status').textContent=`업로드 폴더 전체 삭제 중 · ${deleted}개 객체 정리됨`;
      }while(hasMore);
      for(const entry of entries){entry.url=null;entry.state='deleted';entry.sent=0;entry.bar.style.width='0%';entry.action.textContent='삭제됨';}
    }catch(error){failed++;message('폴더 전체 삭제 실패: '+error.message);}
  }
  cleaning=false;cleanupFailed=failed>0;
  $('cancel').disabled=false;$('cancel-delete').disabled=cleanupFailed&&!removeFiles;$('cancel-keep').disabled=cleanupFailed&&removeFiles;
  $('cleanup-status').textContent=failed?`업로드 정리 또는 폴더 삭제에 실패했습니다. 같은 옵션으로 다시 시도해 주세요.`:removeFiles?'업로드를 취소하고 업로드 폴더 전체를 삭제했습니다.':'업로드를 취소했습니다. 완료된 파일은 유지됩니다.';
  $('upload-notice-message').textContent=$('cleanup-status').textContent;
  if(failed){$('cancel').hidden=false;$('cancel').textContent='취소 처리 다시 시도';}
  else{
    $('clear').hidden=false;
    if(removeFiles){$('share-result').hidden=true;$('share-link').removeAttribute('href');$('share-link').textContent='';}
  }
}
function resetUpload(){
  if(running||cleaning||cleanupFailed)return;
  entries=[];collection=null;cleanupMode=null;uploadLocked=false;started=0;cancelled=false;
  $('share-link').removeAttribute('href');$('share-link').textContent='';
  $('file-list').replaceChildren();$('progress-panel').hidden=true;$('share-result').hidden=true;$('clear').hidden=true;$('start').hidden=false;$('start').textContent='업로드 시작 ↗';
  $('selection').textContent='선택한 파일이 없습니다';$('status').textContent='업로드 준비';
  $('files').value='';$('folder').value='';$('files').disabled=false;$('folder').disabled=false;$('storage').disabled=false;
  $('cancel-options').hidden=true;$('cleanup-status').hidden=true;$('cancel').textContent='업로드 취소';
  $('drop').hidden=false;$('upload-notice').hidden=true;$('upload-again').hidden=true;message();
}
$('clear').onclick=()=>{if(uploadLocked&&!cancelled)return;resetUpload();};
$('new-upload').onclick=()=>{if(entries.length&&entries.every(e=>e.state==='done'))resetUpload();};
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
  if(e.dataTransfer)e.dataTransfer.dropEffect=uploadLocked?'none':'copy';
  if(!$('upload-view').hidden&&!uploadLocked)dropZone.classList.add('dragover');
},true);
window.addEventListener('dragleave',e=>{
  if(!e.relatedTarget)dropZone.classList.remove('dragover');
},true);
window.addEventListener('drop',async e=>{
  e.preventDefault();e.stopPropagation();dropZone.classList.remove('dragover');
  if($('upload-view').hidden)return;
  if(uploadLocked)return message('업로드 시작 이후에는 파일이나 폴더를 추가할 수 없습니다.');
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
function showCompletedLinks(){
  $('share-result').hidden=false;
  $('share-link').href=collection.shareUrl;$('share-link').textContent=collection.shareUrl;
}
window.addEventListener('beforeunload',e=>{if(cleaning||cleanupFailed||uploadLocked&&!cancelled&&entries.some(entry=>entry.state!=='done')){e.preventDefault();e.returnValue='';}});
$('copy-share').onclick=()=>copyText(collection.shareUrl);
async function shared(){
  if(!location.pathname.startsWith('/share/'))return;
  $('upload-view').hidden=true;$('shared-view').hidden=false;
  document.querySelector('h1').innerHTML='파일이 도착했어요<span class="accent">.</span>';
  document.querySelector('.intro').textContent='파일 목록을 확인하고 저장소에서 직접 다운로드하세요. 파일은 언제든 삭제될 수 있으며 보관 기간은 보장되지 않습니다.';
  let cursor=null,count=0;
  try{
    const segments=decodeURIComponent(location.pathname.slice(7)).split('/');
    // Legacy links use the server default provider.
    const storage=/^\d{2}$/.test(segments[0])?null:segments.shift();
    const providers=await api('/api/storages');
    const provider=storage?providers.storages.find(s=>s.id===storage):providers.storages[0];
    if(!provider)throw Error('지원하지 않는 저장소입니다.');
    $('storage-limit').textContent=`${format(provider.maxFileSize)} (약 ${(provider.maxFileSize/1e9).toFixed(1)} GB)`;
    const root=segments.join('/');
    do{
      const data=await api(`/api/files?${new URLSearchParams({...(storage?{storage}:{}),prefix:root,...(cursor?{cursor}:{})})}`);
      for(const file of data.files){row({path:file.name,size:file.size,url:file.url});count++;}
      $('shared-status').textContent=`${count.toLocaleString()}개 파일${data.cursor?' · 목록을 더 불러오는 중입니다.':' · 다운로드 링크는 저장소 파일로 연결됩니다.'}`;
      cursor=data.cursor;
    }while(cursor);
    const archiveParams=new URLSearchParams({storage:provider.id,prefix:root});
    const archive=await api('/api/archive-info?'+archiveParams);
    $('archive-status').textContent=archive.eligible?`합계 ${format(archive.total)} · 폴더 구조를 유지하여 무압축 ZIP으로 다운로드합니다.`:archive.reason;
    if(archive.eligible){$('archive-link').href='/api/archive?'+archiveParams;$('archive-link').hidden=false;}
    if(!count)$('shared-status').textContent='완료된 파일이 없습니다. 업로드 중이거나 파일이 삭제되었을 수 있습니다.';
  }catch(error){$('shared-status').textContent=error.message;$('archive-status').textContent='ZIP 다운로드 가능 여부를 확인하지 못했습니다.';}
}
shared();

async function loadStorages(){
  if(location.pathname.startsWith('/share/'))return;
  try{
    const data=await api('/api/storages');
    const select=$('storage');select.replaceChildren();
    for(const storage of data.storages){
      const option=document.createElement('option');option.value=storage.id;option.textContent=storage.label;select.append(option);
    }
    const updateLimit=()=>{
      const storage=data.storages.find(s=>s.id===select.value);
      if(storage)$('storage-limit').textContent=`${format(storage.maxFileSize)} (약 ${(storage.maxFileSize/1e9).toFixed(1)} GB)`;
    };
    select.onchange=updateLimit;updateLimit();
    if(!data.storages.length)message('사용 가능한 저장소가 없습니다.');
  }catch(error){message('저장소 정보를 불러오지 못했습니다: '+error.message);}
}
loadStorages();
