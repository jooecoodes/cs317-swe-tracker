import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Image, Linking, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {ImageManipulator, SaveFormat} from 'expo-image-manipulator';
import * as Location from 'expo-location';
import {photoIdentity, savePhoto, listPhotos, subscribePhotos, syncPhotosNow, ensurePhotoBackgroundTask, editPhotoTitle} from './photo-queue';

const OUTBOX_PAGE_SIZE = 5;

async function uploadHaptic(success) {
 try {
  if(Platform.OS==='android')await Haptics.performAndroidHapticsAsync(success?Haptics.AndroidHaptics.Confirm:Haptics.AndroidHaptics.Reject);
  else await Haptics.notificationAsync(success?Haptics.NotificationFeedbackType.Success:Haptics.NotificationFeedbackType.Error);
 } catch { /* Visual feedback remains if haptics are disabled. */ }
}
async function pageTapHaptic() {
 try {
  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
 } catch { /* Visual feedback remains if haptics are disabled. */ }
}
function formatPlaceName(place) {
 if (!place || typeof place !== 'object') return '';
 const parts = [];
 for (const raw of [place.district, place.city, place.subregion, place.region]) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value && !/^[0-9A-Z]{4,}\+[0-9A-Z]{2,}$/i.test(value) && !parts.some(p => p.toLowerCase() === value.toLowerCase())) parts.push(value);
  if (parts.length >= 2) break;
 }
 return parts.join(', ');
}
function parseExifTimestamp(exif) {
 if (!exif || typeof exif !== 'object') return null;
 const raw = typeof exif.DateTimeOriginal === 'string' && exif.DateTimeOriginal.trim()
  ? exif.DateTimeOriginal.trim()
  : (typeof exif.DateTimeDigitized === 'string' && exif.DateTimeDigitized.trim() ? exif.DateTimeDigitized.trim() : null);
 if (!raw) return null;
 const match = raw.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
 if (!match) return null;
 const [, y, mo, d, h, mi, s, inlineTz] = match;
 const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s);
 if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
 const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
 if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
 const offsetRaw = inlineTz
  || (typeof exif.OffsetTimeOriginal === 'string' && exif.OffsetTimeOriginal.trim())
  || (typeof exif.OffsetTimeDigitized === 'string' && exif.OffsetTimeDigitized.trim())
  || (typeof exif.OffsetTime === 'string' && exif.OffsetTime.trim())
  || '+08:00';
 let tz = '+08:00';
 if (offsetRaw === 'Z') tz = 'Z';
 else if (/^[+-]\d{2}:\d{2}$/.test(offsetRaw)) tz = offsetRaw;
 else if (/^[+-]\d{4}$/.test(offsetRaw)) tz = `${offsetRaw.slice(0, 3)}:${offsetRaw.slice(3)}`;
 const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz}`;
 return Number.isNaN(Date.parse(iso)) ? null : iso;
}
function Action({label,onPress,disabled=false,secondary=false,loading=false}) {
 return <TouchableOpacity onPress={onPress} disabled={disabled||loading} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:disabled||loading,busy:loading}} style={[styles.button,secondary&&styles.secondary,(disabled&&!loading)&&styles.disabled]}>
  {loading&&<ActivityIndicator size="small" color={secondary?'#285587':'#fff'}/>}
  <Text style={[styles.buttonText,secondary&&styles.secondaryText]}>{label}</Text>
 </TouchableOpacity>;
}
export default function PhotoUpload({baseUrl,getToken,onBusyChange,onIdentity}) {
 const [title,setTitle]=useState('');
 const [editing,setEditing]=useState(null),[editTitle,setEditTitle]=useState(''),[editError,setEditError]=useState('');
 const [identity,setIdentity]=useState(null),[draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Checking your employee account…'),[failed,setFailed]=useState(false);
 const [busyAction,setBusyAction]=useState(''),[busyLabel,setBusyLabel]=useState('');
 const [rows,setRows]=useState([]),[queueMessage,setQueueMessage]=useState(''),[backgroundReady,setBackgroundReady]=useState(true);
 const [outboxOpen,setOutboxOpen]=useState(false),[banner,setBanner]=useState(null),[locationHelp,setLocationHelp]=useState(false),[placeLabel,setPlaceLabel]=useState('');
 const [outboxPage,setOutboxPage]=useState(1),[pageTransitioning,setPageTransitioning]=useState(false);
 const [manualSync,setManualSync]=useState(false),[discardOpen,setDiscardOpen]=useState(false);
 const lastNotice=useRef('');
 /** @type {React.MutableRefObject<ReturnType<typeof setTimeout> | null>} */
 const pageTimer=useRef(null);
 const showBanner=useCallback((title,detail,tone='info',key='',sending=false,openOutbox=true)=>{
  if(key&&lastNotice.current===key)return;
  lastNotice.current=key;
  setBanner({title,detail,tone,sending,openOutbox});
 },[]);
 useEffect(()=>{
  if(!banner)return;
  const timer=setTimeout(()=>setBanner(null),8000);
  return()=>clearTimeout(timer);
 },[banner]);
 const lock=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;if(pageTimer.current)clearTimeout(pageTimer.current);onBusyChange(false);};},[onBusyChange]);
 useEffect(()=>{
  if(!draft){setPlaceLabel('');return;}
  let active=true;
  setPlaceLabel('');
  Location.reverseGeocodeAsync({latitude:draft.metadata.latitude,longitude:draft.metadata.longitude})
   .then(results=>{
    if(!active||!Array.isArray(results)||!results.length)return;
    const label=formatPlaceName(results[0]);
    if(label)setPlaceLabel(label);
   })
   .catch(()=>{/* Keep offline-safe fallback. */});
  return()=>{active=false;};
 },[draft]);
 const loadIdentity=useCallback(async()=>{
  try {
   const info=await photoIdentity(baseUrl,await getToken());
   if(mounted.current){setIdentity(info);onIdentity(info.full_name);setFailed(false);setMessage('');}
   return info;
  } catch(error){if(mounted.current){setFailed(true);setMessage(error.message);}return null;}
 },[baseUrl,getToken,onIdentity]);
 useEffect(()=>{void loadIdentity();},[loadIdentity]);
 useEffect(()=>{
  let active=true;
  const refresh=async()=>{
   if(!identity)return;
   try {const saved=await listPhotos(baseUrl,identity);if(active)setRows(saved);}
   catch {if(active)setQueueMessage('Could not read saved photos. Keep the app installed and try reopening it.');}
  };
  const unsubscribe=subscribePhotos(event=>{
   if(!active)return;
   const notices={
    'title-saved':['Title saved on this phone','Will sync automatically · Tap to view outbox','info',false,true],
    'title-sent':['Title updated','HR can see the correction.','success',false,true],
    saved:['Photo saved on this phone','Will send automatically · Tap to view outbox','warning',false,true],
    sending:['Sending photo…','Uploading in background · Tap to view outbox','info',true,true],
    sent:['Photo sent successfully','HR can now see this photo.','success',false,true],
    waiting:['Photo saved — waiting to send','Will retry automatically · Tap to view outbox','warning',false,true],
    blocked:['Photo needs attention','Tap to open Photo outbox and retry.','error',false,true],
    paused:['Sending is paused',event.message||'Saved photos remain in Photo outbox.','warning',false,true]
   };
   if(event.type==='verified')setBanner(current=>current?.title==='Sending is paused'?null:current);
   const notice=notices[event.type];
   if(notice)showBanner(notice[0],notice[1],notice[2],`${event.id||''}:${event.type}:${event.message||''}`,notice[3],notice[4]);
   if(event.type==='paused'&&active)setQueueMessage(event.message);
   else if(active)setQueueMessage('');
   if(['sent','blocked'].includes(event.type))void uploadHaptic(event.type==='sent');
   void refresh();
  });
  void refresh();
  void ensurePhotoBackgroundTask().then(ok=>{if(active)setBackgroundReady(ok);});
  const timer=setInterval(()=>void refresh(),5000);
  return()=>{active=false;unsubscribe();clearInterval(timer);};
 },[baseUrl,identity,showBanner]);
 async function run(action,actionKey='',initialLabel='') {
  if(lock.current)return;
  lock.current=true;setBusy(true);setBusyAction(actionKey);setBusyLabel(initialLabel);onBusyChange(true);setFailed(false);
  try{await action();}catch(error){if(mounted.current){setFailed(true);setMessage(error.message||'Could not save this photo. Keep the preview and try again.');void uploadHaptic(false);}}
  finally{lock.current=false;if(mounted.current){setBusy(false);setBusyAction('');setBusyLabel('');onBusyChange(false);}}
 }
 const choose=source=>run(async()=>{
  setOutboxOpen(false);setEditing(null);setEditError('');setMessage('');
  if(source==='camera'){
   const permission=await ImagePicker.requestCameraPermissionsAsync();
   if(!permission.granted)throw Error('Camera access is off. Open phone Settings and allow Camera for Northpoint.');
  }
  const permission=await Location.requestForegroundPermissionsAsync();
  if(!permission.granted)throw Error('Location access is off. Open phone Settings and allow precise location.');
  /** @type {ImagePicker.ImagePickerOptions} */
  const options={mediaTypes:['images'],allowsEditing:false,quality:0.85,...(source==='gallery'?{exif:true}:{})};
  const result=source==='camera'?await ImagePicker.launchCameraAsync(options):await ImagePicker.launchImageLibraryAsync(options);
  if(result.canceled){setMessage('');return;}
  const selectedAt=new Date().toISOString();
  setBusyLabel('Finding location…');
  let timer;
  let location;
  try{location=await Promise.race([Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Location is taking too long. Move near a window or outside, then select the photo again.')),30000);})]);}
  finally{clearTimeout(timer);}
  const {latitude,longitude,accuracy}=location.coords;
  if(!Number.isFinite(accuracy)||accuracy>25||accuracy<0)throw Error('Your location is not accurate enough yet. Enable precise location and move outside, then select the photo again.');
  if(Math.abs(Date.now()-location.timestamp)>120000||Math.abs(Date.parse(selectedAt)-location.timestamp)>120000)throw Error('The location reading is too old. Please select the photo again.');
  setBusyLabel('Preparing photo…');
  const asset=result.assets[0];
  const exifTakenAt=source==='gallery'?parseExifTimestamp(asset.exif):null;
  const context=ImageManipulator.manipulate(asset.uri);
  if(Math.max(asset.width,asset.height)>2000)context.resize(asset.width>=asset.height?{width:2000}:{height:2000});
  const rendered=await context.renderAsync();
  const photo=await rendered.saveAsync({format:SaveFormat.JPEG,compress:0.85});
  setTitle('');setLocationHelp(false);
  setDraft({uri:photo.uri,metadata:{upload_id:Crypto.randomUUID(),latitude,longitude,accuracy_m:accuracy,location_at:new Date(location.timestamp).toISOString(),selected_at:selectedAt,source,...(source==='gallery'?{exif_taken_at:exifTakenAt}:{})}});
  setMessage('');
 },source,source==='camera'?'Opening camera…':'Opening gallery…');
 const send=()=>run(async()=>{
  if(!draft||!identity)return;
  if(!title.trim())throw Error('Please enter a photo title before sending.');
  await savePhoto({...draft,metadata:{...draft.metadata,title:title.trim()}},baseUrl,identity);
  if(!mounted.current)return;
  setDraft(null);setMessage('');
  setRows(await listPhotos(baseUrl,identity));
 },'send','Saving photo…');
 const titleEditor=row=>{
  if(editing!==row.id)return null;
  const savingEdit=busyAction===`edit:${row.id}`;
  return <View style={styles.editPanel}>
   <Text style={styles.editLabel}>Edit Title</Text>
   <TextInput accessibilityLabel="Edit title, required" value={editTitle} onChangeText={value=>{setEditTitle(value);setEditError('');}} maxLength={120} editable={!busy} returnKeyType="done" style={styles.editInput}/>
   {!!editError&&<Text style={styles.error} accessibilityLiveRegion="polite">{editError}</Text>}
   {!editTitle.trim()&&<Text style={styles.editHint}>Please enter a photo title before saving.</Text>}
   <View style={styles.editActions}>
    <TouchableOpacity disabled={busy} accessibilityRole="button" accessibilityLabel="Cancel editing title" accessibilityState={{disabled:busy}} style={[styles.editCancelButton,busy&&styles.disabled]} onPress={()=>{setEditing(null);setEditError('');}}><Text style={styles.editCancelText}>Cancel</Text></TouchableOpacity>
    <TouchableOpacity disabled={busy||!editTitle.trim()} accessibilityRole="button" accessibilityLabel="Save photo title" accessibilityState={{disabled:busy||!editTitle.trim(),busy:savingEdit}} style={[styles.editSaveButton,((busy&&!savingEdit)||!editTitle.trim())&&styles.disabled]} onPress={()=>run(async()=>{
     try {
      await editPhotoTitle(row.id,editTitle,baseUrl,identity);
      setRows(await listPhotos(baseUrl,identity));setEditing(null);setEditError('');
     } catch(error){setEditError(error.message||'Could not save the title. Please try again.');}
    },`edit:${row.id}`)}>
     {savingEdit&&<ActivityIndicator size="small" color="#fff"/>}
     <Text style={styles.editSaveText}>{savingEdit?'Saving…':'Save'}</Text>
    </TouchableOpacity>
   </View>
  </View>;
 };
 const pending=rows.filter(row=>row.state!=='sent');
 const pendingTitles=rows.filter(row=>row.title_pending).length;
 const hasPending=pending.length>0||pendingTitles>0;
 const attention=pending.filter(row=>row.state==='blocked').length;
 const outboxPages=Math.max(1,Math.ceil(rows.length/OUTBOX_PAGE_SIZE));
 const currentPage=Math.min(outboxPage,outboxPages);
 const pageStart=(currentPage-1)*OUTBOX_PAGE_SIZE;
 const pageEnd=Math.min(pageStart+OUTBOX_PAGE_SIZE,rows.length);
 const pageRange=pageStart+1===pageEnd?`${pageEnd} of ${rows.length}`:`${pageStart+1}–${pageEnd} of ${rows.length}`;
 const visibleRows=rows.slice(pageStart,pageEnd);
 useEffect(()=>{if(outboxPage>outboxPages)setOutboxPage(outboxPages);},[outboxPage,outboxPages]);
 const changeOutboxPage=nextPage=>{
  const clamped=Math.max(1,Math.min(outboxPages,nextPage));
  if(clamped===currentPage)return;
  void pageTapHaptic();
  setEditing(null);setEditError('');
  if(pageTimer.current)clearTimeout(pageTimer.current);
  setPageTransitioning(true);
  pageTimer.current=setTimeout(()=>{
   pageTimer.current=null;
   if(!mounted.current)return;
   setOutboxPage(clamped);
   setPageTransitioning(false);
  },180);
 };
 return <>
  <View style={styles.card}>
   <Text style={styles.heading} accessibilityRole="header">Send a work photo</Text>
   {!identity&&<Text style={styles.body}>Checking your linked employee account.</Text>}
   {!identity&&<Action label={busyAction==='identity'?'Checking…':'Check My Account'} loading={busyAction==='identity'} onPress={()=>run(loadIdentity,'identity','Checking…')} disabled={busy} secondary/>}
   {!draft&&identity&&<>
    <Action label={busyAction==='camera'?(busyLabel||'Working…'):'Take a Photo'} loading={busyAction==='camera'} onPress={()=>choose('camera')} disabled={busy}/>
    <Action label={busyAction==='gallery'?(busyLabel||'Working…'):'Choose from Gallery'} loading={busyAction==='gallery'} onPress={()=>choose('gallery')} disabled={busy} secondary/>
   </>}
   {draft&&<><Image source={{uri:draft.uri}} style={styles.preview} accessibilityLabel="Photo ready to save and send"/>
    <Text style={styles.body}>{new Date(draft.metadata.selected_at).toLocaleString()}</Text>
    <Text style={styles.locationTitle}>Photo Title / Area Supervised</Text>
    <TextInput accessibilityLabel="Photo Title / Area Supervised, required" placeholder="Enter area or site name, e.g., Gate 2 Inspection" placeholderTextColor="#526176" value={title} onChangeText={setTitle} maxLength={120} editable={!busy} multiline style={{fontSize:18,lineHeight:26,minHeight:64,borderWidth:1,borderColor:'#697e97',borderRadius:10,padding:12,color:'#1e3857',backgroundColor:'#fff'}}/>
    {!title.trim()&&<Text style={styles.note}>Please enter a photo title before sending.</Text>}
    <Action label={busyAction==='send'?'Saving photo…':'Send Photo'} loading={busyAction==='send'} onPress={send} disabled={busy||!title.trim()}/>
    <Action label="Discard Preview" secondary disabled={busy} onPress={()=>setDiscardOpen(true)}/>
    <Text style={styles.note}>Send Photo saves it for automatic upload, even offline.</Text>
    <View style={styles.locationInlineWrap}>
     <View style={styles.locationInline}>
      <Text style={styles.locationInlineText} numberOfLines={2}>✓ {placeLabel||'Location attached'}{draft.metadata.source==='gallery'?' · Gallery photo':''}</Text>
      {draft.metadata.source==='gallery'&&<TouchableOpacity style={styles.helpButton} onPress={()=>setLocationHelp(open=>!open)} accessibilityRole="button" accessibilityLabel="About gallery photo location" accessibilityState={{expanded:locationHelp}}><Text style={styles.helpIcon}>?</Text></TouchableOpacity>}
     </View>
     {locationHelp&&draft.metadata.source==='gallery'&&<Text style={styles.helpText} accessibilityLiveRegion="polite">Uses your location when you selected this photo, not necessarily where it was taken. Tap ? to close.</Text>}
    </View>
   </>}
   {!!message&&(failed||!identity)&&<Text accessibilityLiveRegion="polite" style={[styles.message,failed&&styles.error]}>{message}</Text>}
   {failed&&/access is off|precise location/i.test(message)&&<Action label="Open Phone Settings" onPress={()=>Linking.openSettings()} disabled={busy} secondary/>}
   {!!banner&&<TouchableOpacity activeOpacity={banner.openOutbox?0.75:1} disabled={!banner.openOutbox} onPress={()=>{if(banner.openOutbox)setOutboxOpen(true);}} accessibilityRole={banner.openOutbox?'button':'text'} accessibilityLabel={`${banner.title}. ${banner.detail}`} accessibilityLiveRegion="polite" style={[styles.banner,banner.tone==='success'&&styles.bannerSuccess,banner.tone==='error'&&styles.bannerError,banner.tone==='warning'&&styles.bannerWarning]}>
    <View style={styles.bannerIconWrap} accessible={false}>
     {banner.sending?<ActivityIndicator size="small" color="#285587"/>:<Text style={[styles.bannerIcon,banner.tone==='success'&&styles.successText,banner.tone==='error'&&styles.error,banner.tone==='warning'&&styles.warningText]}>{banner.tone==='success'?'✓':banner.tone==='info'?'i':'!'}</Text>}
    </View>
    <View style={styles.bannerCopy}>
     <Text style={[styles.bannerTitle,banner.tone==='success'&&styles.successText,banner.tone==='error'&&styles.error,banner.tone==='warning'&&styles.warningText]}>{banner.title}</Text>
     <Text style={styles.bannerDetail}>{banner.detail}</Text>
    </View>
   </TouchableOpacity>}
   </View>
  <View style={[styles.card,styles.outboxCard]}>
  <TouchableOpacity style={styles.outboxToggle} onPress={()=>setOutboxOpen(open=>!open)} accessibilityRole="button"
   accessibilityLabel={`Photo outbox, ${pending.length} waiting${attention?`, ${attention} need attention`:''}`}
   accessibilityHint={outboxOpen?'Hide saved and sent photos':'Show saved and sent photos'} accessibilityState={{expanded:outboxOpen}}>
   <View style={styles.outboxLabel}><Text style={styles.outboxTitle}>Photo outbox · {pending.length} waiting</Text>
    {!!pendingTitles&&<Text style={styles.note}>{pendingTitles} title {pendingTitles===1?'update':'updates'} waiting to sync</Text>}
    {!!attention&&<Text style={styles.error}>{attention} need attention</Text>}
   </View>
   <Text style={styles.outboxArrow} accessible={false}>{outboxOpen?'▴':'▾'}</Text>
  </TouchableOpacity>
  {outboxOpen&&<View style={styles.outboxContents}>
  {!!queueMessage&&banner?.title!=='Sending is paused'&&<Text style={styles.message} accessibilityLiveRegion="polite">{queueMessage}</Text>}
  {!backgroundReady&&<Text style={styles.note}>Background sending is unavailable in phone settings. Saved photos will send automatically while this app is open.</Text>}
  <Action label={manualSync?'Syncing…':'Sync Now'} secondary={!hasPending} loading={manualSync} disabled={busy||!identity} onPress={()=>run(async()=>{
   setManualSync(true);
   try {await syncPhotosNow(baseUrl,identity);setRows(await listPhotos(baseUrl,identity));}
   finally {setManualSync(false);}
  },'sync')}/>
  <View style={[styles.outboxList,pageTransitioning&&styles.outboxListDimmed]}>
  {visibleRows.map(row=>{
   const meta=JSON.parse(row.metadata);
   const rowTitle=row.edit_title||meta.title||'Untitled Photo';
   const syncing=(row.state!=='sent'&&row.lease_until>Date.now()) || (row.title_pending&&row.title_lease_until>Date.now());
   const pendingTitle=!!row.title_pending, synced=row.state==='sent'&&!pendingTitle, blocked=row.state==='blocked';
   const label=syncing?'Sending':synced?'Synced':blocked?'Needs attention':'Waiting';
   return <View key={row.id} style={styles.outboxItem}>
    <View style={styles.itemTop}>
     <Text style={styles.itemTitle} numberOfLines={2}>{rowTitle}</Text>
     <View style={[styles.statusBadge,synced&&styles.syncedBadge,blocked&&styles.blockedBadge]}>
      <Text style={[styles.statusText,blocked&&styles.blockedText]}>{label}</Text>
     </View>
    </View>
    <View style={styles.itemBottom}>
     <View style={styles.itemMeta}>
      <Text style={styles.itemDate}>{new Date(meta.selected_at).toLocaleString()}</Text>
      {row.state==='sent'&&pendingTitle&&<Text style={styles.itemSubnote}>Title correction pending</Text>}
      {!synced&&!syncing&&<Text accessibilityLiveRegion="polite" style={styles.itemNote}>{pendingTitle?row.title_message:row.message}</Text>}
     </View>
     {editing!==row.id&&<TouchableOpacity disabled={busy} accessibilityRole="button" accessibilityLabel={`Edit title for ${rowTitle}`} accessibilityState={{disabled:busy}} style={[styles.compactButton,busy&&styles.disabled]} onPress={()=>{setEditing(row.id);setEditTitle(rowTitle);setEditError('');}}><Text style={styles.compactButtonText}>Edit Title</Text></TouchableOpacity>}
    </View>
    {syncing&&<ActivityIndicator color="#285587"/>}
    {titleEditor(row)}
   </View>;
  })}
  </View>
  {rows.length>OUTBOX_PAGE_SIZE&&<View style={styles.pagination}>
   <TouchableOpacity disabled={currentPage<=1} accessibilityRole="button" accessibilityLabel="Previous outbox page" accessibilityState={{disabled:currentPage<=1}} style={[styles.pageButton,currentPage<=1&&styles.disabled]} onPress={()=>changeOutboxPage(currentPage-1)}><Text style={styles.pageButtonText}>Previous</Text></TouchableOpacity>
   <Text style={styles.pageInfo}>{pageRange}</Text>
   <TouchableOpacity disabled={currentPage>=outboxPages} accessibilityRole="button" accessibilityLabel="Next outbox page" accessibilityState={{disabled:currentPage>=outboxPages}} style={[styles.pageButton,currentPage>=outboxPages&&styles.disabled]} onPress={()=>changeOutboxPage(currentPage+1)}><Text style={styles.pageButtonText}>Next</Text></TouchableOpacity>
  </View>}
  {!rows.length&&<Text style={styles.body}>No saved photos yet.</Text>}
  {!!(pending.length||pendingTitles)&&<Text style={styles.note}>Syncing retries automatically. If an item stays waiting, tap Sync Now and read its note above.</Text>}
  </View>}
  </View>
  <Modal visible={discardOpen} transparent animationType="fade" onRequestClose={()=>setDiscardOpen(false)}>
   <View style={styles.modalBackdrop}>
    <View style={styles.modalCard} accessibilityViewIsModal>
     <Text style={styles.modalTitle} accessibilityRole="header">Discard this preview?</Text>
     <Text style={styles.modalBody}>This photo has not been saved to your outbox yet.</Text>
     <View style={styles.modalActions}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Keep Photo" style={styles.modalCancelButton} onPress={()=>setDiscardOpen(false)}>
       <Text style={styles.modalCancelText}>Keep Photo</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Discard preview" style={styles.modalDangerButton} onPress={()=>{setDiscardOpen(false);setDraft(null);setMessage('');}}>
       <Text style={styles.modalDangerText}>Discard</Text>
      </TouchableOpacity>
     </View>
    </View>
   </View>
  </Modal>
 </>;
}
const styles=StyleSheet.create({
 outboxItem:{backgroundColor:'#fff',borderWidth:1,borderColor:'#cbd8e7',borderRadius:12,padding:12,gap:8},
 itemTop:{flexDirection:'row',alignItems:'flex-start',justifyContent:'space-between',gap:8},
 itemTitle:{flex:1,fontSize:16,lineHeight:22,fontWeight:'700',color:'#1e3857'},
 statusBadge:{backgroundColor:'#edf3fa',borderRadius:14,paddingVertical:4,paddingHorizontal:10,flexShrink:0},
 syncedBadge:{backgroundColor:'#dfeaf7'},blockedBadge:{backgroundColor:'#fff0ef',borderWidth:1,borderColor:'#d99b9b'},
 statusText:{fontSize:13,lineHeight:18,fontWeight:'700',color:'#234e7d'},blockedText:{color:'#963232'},
 itemBottom:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10},
 itemMeta:{flex:1,gap:2},itemDate:{fontSize:14,lineHeight:20,color:'#526176'},itemSubnote:{fontSize:13,lineHeight:18,color:'#285587',fontWeight:'600'},
 itemNote:{fontSize:14,lineHeight:20,color:'#405670'},
 compactButton:{minHeight:44,paddingVertical:8,paddingHorizontal:12,borderRadius:8,backgroundColor:'#edf3fa',borderWidth:1,borderColor:'#285587',justifyContent:'center',alignItems:'center',flexShrink:0},
 compactButtonText:{fontSize:14,lineHeight:20,fontWeight:'700',color:'#1e3857'},
 pagination:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8,paddingTop:4},
 pageButton:{minHeight:44,paddingVertical:8,paddingHorizontal:14,borderRadius:8,backgroundColor:'#edf3fa',borderWidth:1,borderColor:'#285587',justifyContent:'center',alignItems:'center'},
 pageButtonText:{fontSize:14,lineHeight:20,fontWeight:'700',color:'#1e3857'},
 pageInfo:{fontSize:14,lineHeight:20,fontWeight:'600',color:'#526176',textAlign:'center'},
 outboxList:{gap:10},outboxListDimmed:{opacity:0.45},
 editPanel:{backgroundColor:'#f4f7fb',borderWidth:1,borderColor:'#d6e1ed',padding:10,borderRadius:10,gap:8},
 editLabel:{fontSize:14,lineHeight:20,fontWeight:'700',color:'#1e3857'},
 editInput:{fontSize:15,lineHeight:20,minHeight:44,borderWidth:1,borderColor:'#697e97',borderRadius:8,paddingHorizontal:10,paddingVertical:8,color:'#1e3857',backgroundColor:'#fff'},
 editHint:{fontSize:13,lineHeight:18,color:'#526176'},
 editActions:{flexDirection:'row',gap:8},
 editCancelButton:{flex:1,minHeight:44,borderRadius:8,backgroundColor:'#edf3fa',borderWidth:1,borderColor:'#285587',justifyContent:'center',alignItems:'center'},
 editCancelText:{fontSize:15,lineHeight:20,fontWeight:'700',color:'#1e3857'},
 editSaveButton:{flex:1,minHeight:44,borderRadius:8,backgroundColor:'#285587',flexDirection:'row',gap:6,justifyContent:'center',alignItems:'center'},
 editSaveText:{fontSize:15,lineHeight:20,fontWeight:'700',color:'#fff'},
 outboxToggle:{minHeight:56,flexDirection:'row',alignItems:'center',gap:12,padding:14,borderWidth:1,borderColor:'#b8c9dd',borderRadius:10,backgroundColor:'#edf3fa'},outboxLabel:{flex:1,gap:4},outboxTitle:{fontSize:18,lineHeight:26,fontWeight:'700',color:'#1e3857'},outboxArrow:{fontSize:25,color:'#285587'},outboxContents:{gap:12},
 card:{marginTop:20,padding:20,backgroundColor:'#fff',borderColor:'#cbd5e2',borderWidth:1,borderRadius:18,gap:12},
 outboxCard:{padding:16},
 heading:{fontSize:24,lineHeight:32,fontWeight:'700',color:'#1e3857'},body:{fontSize:17,lineHeight:26,color:'#33465e'},
 button:{minHeight:56,flexDirection:'row',gap:10,justifyContent:'center',alignItems:'center',padding:14,borderRadius:10,backgroundColor:'#285587'},
 secondary:{backgroundColor:'#edf3fa',borderColor:'#285587',borderWidth:1},buttonText:{fontSize:18,lineHeight:26,fontWeight:'700',color:'#fff',textAlign:'center'},secondaryText:{color:'#1e3857'},disabled:{opacity:0.5},
 preview:{width:'100%',height:240,resizeMode:'contain',backgroundColor:'#edf3fa',borderRadius:12},
 locationInlineWrap:{gap:4},locationInline:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:6},
 locationInlineText:{flex:1,fontSize:14,lineHeight:20,fontWeight:'600',color:'#26745d'},
 helpButton:{width:44,height:44,alignItems:'center',justifyContent:'center'},helpIcon:{width:24,height:24,lineHeight:22,textAlign:'center',borderRadius:12,borderWidth:1,borderColor:'#697586',backgroundColor:'#e5e7eb',color:'#374151',fontSize:15,fontWeight:'700'},helpText:{fontSize:14,lineHeight:20,color:'#374151',backgroundColor:'#f3f4f6',padding:10,borderRadius:8},
 locationTitle:{fontSize:18,fontWeight:'700',color:'#1e3857'},
 banner:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:10,paddingHorizontal:12,borderRadius:10,borderWidth:1,borderColor:'#b8c9dd',borderLeftWidth:4,borderLeftColor:'#285587',backgroundColor:'#edf3fa'},
 bannerSuccess:{backgroundColor:'#e7f5ed',borderColor:'#a7d7bc',borderLeftColor:'#26745d'},
 bannerWarning:{backgroundColor:'#fff5dd',borderColor:'#e4c57b',borderLeftColor:'#b7791f'},
 bannerError:{backgroundColor:'#fff0ef',borderColor:'#e4b0ae',borderLeftColor:'#963232'},
 bannerIconWrap:{width:26,height:26,alignItems:'center',justifyContent:'center',flexShrink:0},
 bannerIcon:{fontSize:18,fontWeight:'700',color:'#285587'},
 bannerCopy:{flex:1,gap:2},bannerTitle:{fontSize:15,lineHeight:21,fontWeight:'700',color:'#1e3857'},bannerDetail:{fontSize:13,lineHeight:19,color:'#33465e'},
 successText:{color:'#175637'},warningText:{color:'#694900'},
 modalBackdrop:{flex:1,backgroundColor:'rgba(15,29,46,0.48)',justifyContent:'center',alignItems:'center',padding:24},
 modalCard:{width:'100%',maxWidth:360,backgroundColor:'#fff',borderRadius:18,borderWidth:1,borderColor:'#cbd5e2',padding:20,gap:12,elevation:6},
 modalTitle:{fontSize:20,lineHeight:28,fontWeight:'700',color:'#1e3857'},
 modalBody:{fontSize:15,lineHeight:22,color:'#526176'},
 modalActions:{flexDirection:'row',gap:10,marginTop:4},
 modalCancelButton:{flex:1,minHeight:44,borderRadius:10,backgroundColor:'#edf3fa',borderWidth:1,borderColor:'#285587',justifyContent:'center',alignItems:'center',paddingHorizontal:12},
 modalCancelText:{fontSize:15,lineHeight:20,fontWeight:'700',color:'#1e3857'},
 modalDangerButton:{flex:1,minHeight:44,borderRadius:10,backgroundColor:'#ac4544',justifyContent:'center',alignItems:'center',paddingHorizontal:12},
 modalDangerText:{fontSize:15,lineHeight:20,fontWeight:'700',color:'#fff'},
 message:{fontSize:17,lineHeight:26,fontWeight:'600',color:'#1e3857'},error:{color:'#963232'},note:{fontSize:15,lineHeight:23,color:'#526176'}
});
