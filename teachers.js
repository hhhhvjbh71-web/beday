// ============================================================
//  teachers.js  v2.0 — نظام حسابات المدرسين المتكامل
//  مُربوط بـ halls.js (جدول الحصص المركزي)
// ============================================================

(function () {
  'use strict';

  const ARABIC_DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const DAY_KEYS    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // ── State ──
  let _teachers  = [];
  let _logs      = [];   // سجل تسجيل الحصص الفعلي
  let _payouts   = [];   // سجل المدفوعات
  let _advances  = [];   // سجل السلف
  let _activeTeacherId = null;
  let _dateFilter = 'month';
  let _customFrom = null;
  let _customTo   = null;

  // ── DB helpers ──
  async function loadAll(){
    if(typeof StorageEngine==='undefined') return;
    _teachers = await _safe('teachers');
    _logs     = await _safe('teacherLogs');
    _payouts  = await _safe('teacherPayouts');
    _advances = await _safe('teacherAdvances');
    await _ensureStores();
  }

  async function _safe(store){
    try{
      if(!StorageEngine.db||!StorageEngine.db.objectStoreNames.contains(store)) await _ensureStores();
      return await StorageEngine.getAll(store)||[];
    }catch(e){ console.warn('[teachers]',store,e); return []; }
  }

  async function _ensureStores(){
    return new Promise(resolve=>{
      if(!StorageEngine.db) return resolve();
      const needed=['teachers','teacherLogs','teacherPayouts','teacherAdvances'];
      const existing=Array.from(StorageEngine.db.objectStoreNames);
      const missing=needed.filter(n=>!existing.includes(n));
      if(missing.length===0) return resolve();
      const ver=StorageEngine.db.version+1;
      StorageEngine.db.close();
      const req=indexedDB.open('EduMasterLargeDB',ver);
      req.onupgradeneeded=e=>{
        const db2=e.target.result;
        missing.forEach(n=>{ if(!db2.objectStoreNames.contains(n)) db2.createObjectStore(n,{keyPath:'id'}); });
      };
      req.onsuccess=e=>{ StorageEngine.db=e.target.result; resolve(); };
      req.onerror=()=>resolve();
    });
  }

  async function _saveArr(store, arr){
    await _ensureStores();
    if(!Array.isArray(arr)) arr=[arr];
    if(arr.length===0) return;
    for(const item of arr) await StorageEngine.save(store, item);
  }
  async function _delFrom(store,id){
    await _ensureStores();
    await StorageEngine.delete(store,id);
  }

  // ── Helpers ──
  function _esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function notify(msg,type='success'){ if(typeof showNotification==='function') showNotification(msg,type); else alert(msg); }
  function grpName(gid){
    if(!gid) return 'عام';
    const g=(window.db&&db.groups||[]).find(x=>String(x.id)===String(gid));
    return g?g.name:'مجموعة';
  }
  function gLabel(gid){
    const g=(window.gradesList||[]).find(x=>String(x.id)===String(gid)||String(x.systemCode)===String(gid));
    return g?g.name:(gid||'---');
  }
  function hallName(hid){
    const halls=window.HallsModule?HallsModule.getHalls():[];
    const h=halls.find(x=>String(x.id)===String(hid));
    return h?h.name:'---';
  }

  // ── Get lessons for teacher ──
  function _teacherLessons(teacherId){
    const lessons=window.HallsModule?HallsModule.getLessons():[];
    return lessons.filter(l=>String(l.teacherId)===String(teacherId));
  }

  // ── Date helpers ──
  function _dateRange(){
    const now=new Date(), str=d=>d.toISOString().split('T')[0];
    if(_dateFilter==='today') return {from:str(now),to:str(now)};
    if(_dateFilter==='week'){ const s=new Date(now); s.setDate(now.getDate()-6); return {from:str(s),to:str(now)}; }
    if(_dateFilter==='month'){ const s=new Date(now); s.setDate(1); return {from:str(s),to:str(now)}; }
    if(_dateFilter==='custom') return {from:_customFrom||'2000-01-01',to:_customTo||str(now)};
    return {from:'2000-01-01',to:str(now)};
  }
  function _inRange(d,from,to){ if(!d) return false; const x=d.substring(0,10); return x>=from&&x<=to; }

  // ── Calculate financials ──
  function _calcDue(teacherId, logs=null){
    const t=_teachers.find(x=>x.id===teacherId);
    if(!t) return 0;
    const useLogs=logs||_logs.filter(l=>l.teacherId===teacherId&&l.status==='attended');
    return useLogs.reduce((sum,l)=>{
      // Find price from teacher assignments
      const a=(t.assignments||[]).find(x=>
        String(x.grade)===String(l.grade) &&
        (String(x.groupId)===String(l.groupId)||(!x.groupId&&!l.groupId)||(!x.groupId))
      );
      const price=a?a.pricePerSession:0;
      return sum+(price||0);
    },0);
  }

  function _calcPaid(teacherId){ return _payouts.filter(p=>p.teacherId===teacherId).reduce((s,p)=>s+(p.amount||0),0); }
  function _calcAdvances(teacherId){ return _advances.filter(a=>a.teacherId===teacherId).reduce((s,a)=>s+(a.amount||0),0); }

  // ══════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════
  async function initTeachersSection(){
    await loadAll();
    renderTeachersGrid();
    _activeTeacherId=null;
  }

  // ══════════════════════════════════════════════════════════
  //  TEACHERS GRID
  // ══════════════════════════════════════════════════════════
  function renderTeachersGrid(){
    const container=document.getElementById('teachers-grid');
    if(!container) return;
    const search=(document.getElementById('teachers-search')?.value||'').toLowerCase().trim();
    const list=_teachers.filter(t=>!search||t.name.toLowerCase().includes(search));

    if(list.length===0){
      container.innerHTML=`
        <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">
          <i class="fas fa-chalkboard-teacher" style="font-size:3rem;opacity:0.3;display:block;margin-bottom:1rem;"></i>
          <p>لا يوجد مدرسون مضافون حتى الآن.</p>
          <button class="btn btn-primary" onclick="TeachersModule.showAddTeacherModal()"
            style="margin-top:1rem;border-radius:12px;padding:0.7rem 2rem;">
            <i class="fas fa-plus"></i> أضف مدرساً الآن
          </button>
        </div>`;
      return;
    }

    container.innerHTML=list.map(t=>{
      const totalDue=_calcDue(t.id);
      const totalPaid=_calcPaid(t.id);
      const totalAdv=_calcAdvances(t.id);
      const remaining=Math.max(0, totalDue-totalPaid-totalAdv);
      const tLessons=_teacherLessons(t.id);
      const todayKey=DAY_KEYS[new Date().getDay()];
      const todayLessons=tLessons.filter(l=>l.day===todayKey);

      return `
        <div class="teacher-card" onclick="TeachersModule.openTeacherAccount(${t.id})" style="
          background:var(--bg-white);border-radius:18px;padding:1.4rem;
          box-shadow:0 2px 12px rgba(0,0,0,0.07);cursor:pointer;transition:all 0.2s;
          border:1.5px solid transparent;position:relative;overflow:hidden;"
          onmouseover="this.style.boxShadow='0 8px 24px rgba(0,0,0,0.12)';this.style.borderColor='var(--primary)'"
          onmouseout="this.style.boxShadow='0 2px 12px rgba(0,0,0,0.07)';this.style.borderColor='transparent'">
          <div style="position:absolute;top:0;right:0;width:4px;height:100%;background:linear-gradient(180deg,#4f46e5,#7c3aed);border-radius:0 18px 18px 0;"></div>
          <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;">
            <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c3aed);
              display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:1.2rem;flex-shrink:0;">
              ${t.name.charAt(0)}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:800;font-size:1rem;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(t.name)}</div>
              <div style="font-size:0.8rem;color:var(--text-muted);">${_esc(t.subject||'لا توجد مادة')}</div>
            </div>
            <div style="display:flex;gap:6px;" onclick="event.stopPropagation()">
              <button onclick="TeachersModule.showAddTeacherModal(${t.id})"
                style="width:30px;height:30px;border:none;border-radius:8px;background:var(--bg-light);cursor:pointer;color:var(--primary);">
                <i class="fas fa-edit" style="font-size:0.72rem;"></i>
              </button>
              <button onclick="TeachersModule.deleteTeacher(${t.id})"
                style="width:30px;height:30px;border:none;border-radius:8px;background:#fef2f2;cursor:pointer;color:#ef4444;">
                <i class="fas fa-trash" style="font-size:0.72rem;"></i>
              </button>
            </div>
          </div>

          <!-- Today's sessions -->
          ${todayLessons.length>0?`
            <div style="background:#f0f9ff;border-radius:8px;padding:0.5rem 0.75rem;margin-bottom:0.75rem;font-size:0.75rem;">
              <span style="color:#0ea5e9;font-weight:700;"><i class="fas fa-calendar-day" style="margin-left:3px;"></i>اليوم: ${todayLessons.length} حصة</span>
              ${todayLessons.map(l=>`<span style="color:var(--text-muted);margin-right:8px;">${l.timeFrom}–${l.timeTo}</span>`).join('')}
            </div>`:``}

          <!-- Financial summary -->
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.4rem;text-align:center;">
            <div style="background:var(--bg-light);border-radius:9px;padding:0.45rem;">
              <div style="font-size:1rem;font-weight:800;color:#16a34a;">${tLessons.length}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">ح/أسبوع</div>
            </div>
            <div style="background:var(--bg-light);border-radius:9px;padding:0.45rem;">
              <div style="font-size:1rem;font-weight:800;color:#4f46e5;">${totalDue.toLocaleString('ar-EG')}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">إجمالي ج</div>
            </div>
            <div style="background:var(--bg-light);border-radius:9px;padding:0.45rem;">
              <div style="font-size:1rem;font-weight:800;color:${remaining>0?'#ef4444':'#16a34a'};">${remaining.toLocaleString('ar-EG')}</div>
              <div style="font-size:0.65rem;color:var(--text-muted);">متبقي ج</div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ══════════════════════════════════════════════════════════
  //  TEACHER FORM MODAL
  // ══════════════════════════════════════════════════════════
  function showAddTeacherModal(editId=null){
    const t=editId?_teachers.find(x=>x.id===editId):null;
    const assignments=t?.assignments||[{grade:'',groupId:'',pricePerSession:''}];

    const modal=_mkModal('teacher-form-modal',`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
        <h2 style="margin:0;color:var(--primary);font-size:1.15rem;font-weight:800;">
          <i class="fas fa-chalkboard-teacher" style="margin-left:8px;"></i>
          ${editId?'تعديل بيانات المدرس':'إضافة مدرس جديد'}
        </h2>
        <button onclick="window._closeModal('teacher-form-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.2rem;">
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">اسم المدرس *</label>
          <input id="t-name" type="text" class="form-input" value="${_esc(t?.name||'')}" placeholder="مثال: أحمد محمد">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">المادة *</label>
          <input id="t-subject" type="text" class="form-input" value="${_esc(t?.subject||'')}" placeholder="مثال: الفيزياء">
        </div>
      </div>

      <!-- الصفوف والمجموعات وسعر الحصة -->
      <div style="margin-bottom:1.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.7rem;">
          <label style="font-weight:700;font-size:0.9rem;"><i class="fas fa-layer-group" style="color:var(--primary);margin-left:5px;"></i>الصفوف والمجموعات وأسعار الحصص</label>
          <button onclick="TeachersModule._addAssignRow()" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:0.8rem;">
            <i class="fas fa-plus"></i> إضافة
          </button>
        </div>
        <div id="t-assignments-list">
          ${assignments.map((a,i)=>_assignRowHTML(a,i)).join('')}
        </div>
      </div>

      <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
        <button onclick="window._closeModal('teacher-form-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._saveTeacher(${editId||'null'})" class="btn btn-primary" style="border-radius:10px;padding:0.6rem 2rem;">
          <i class="fas fa-save"></i> حفظ
        </button>
      </div>
    `);
    document.body.appendChild(modal);
    _bindGradeListeners();
  }

  function showEditTeacherModal(id){ showAddTeacherModal(id); }

  function _assignRowHTML(a={},i=0){
    const gradeOpts=_buildGradeOpts(a.grade||'');
    const groupOpts=_buildGroupOpts(a.grade||'',a.groupId||'');
    return `
      <div class="t-assign-row" style="display:grid;grid-template-columns:1fr 1fr 1fr 36px;gap:0.5rem;margin-bottom:0.5rem;align-items:center;">
        <select class="form-input t-grade-sel" style="font-size:0.84rem;" onchange="TeachersModule._onGradeChange(this,${i})">
          <option value="">اختر الصف</option>
          ${gradeOpts}
        </select>
        <select class="form-input t-group-sel" style="font-size:0.84rem;">
          <option value="">اختر المجموعة</option>
          ${groupOpts}
        </select>
        <input type="number" class="form-input t-price-inp" min="0" placeholder="سعر الحصة (ج)" style="font-size:0.84rem;" value="${a.pricePerSession||''}">
        <button onclick="this.closest('.t-assign-row').remove()"
          style="background:#fef2f2;border:none;border-radius:8px;height:38px;width:36px;cursor:pointer;color:#ef4444;">
          <i class="fas fa-minus"></i>
        </button>
      </div>`;
  }

  function _addAssignRow(){
    const list=document.getElementById('t-assignments-list');
    if(!list) return;
    const i=list.querySelectorAll('.t-assign-row').length;
    list.insertAdjacentHTML('beforeend',_assignRowHTML({},i));
    _bindGradeListeners();
  }

  function _onGradeChange(sel){
    const row=sel.closest('.t-assign-row');
    const grpSel=row?.querySelector('.t-group-sel');
    if(grpSel) grpSel.innerHTML='<option value="">اختر المجموعة</option>'+_buildGroupOpts(sel.value,'');
  }

  function _bindGradeListeners(){
    document.querySelectorAll('.t-grade-sel').forEach(sel=>{
      sel.onchange=function(){ _onGradeChange(this); };
    });
  }

  async function _saveTeacher(editId){
    const name=document.getElementById('t-name')?.value.trim();
    const subject=document.getElementById('t-subject')?.value.trim();
    if(!name) return notify('يرجى إدخال اسم المدرس','error');
    if(!subject) return notify('يرجى إدخال المادة','error');

    const assignments=[];
    document.querySelectorAll('.t-assign-row').forEach(row=>{
      const grade=row.querySelector('.t-grade-sel')?.value;
      const groupId=row.querySelector('.t-group-sel')?.value||null;
      const pricePerSession=parseFloat(row.querySelector('.t-price-inp')?.value)||0;
      if(grade) assignments.push({grade,groupId,pricePerSession});
    });

    const teacherId=editId||Date.now();
    if(editId){
      const idx=_teachers.findIndex(t=>t.id===editId);
      if(idx!==-1) _teachers[idx]={..._teachers[idx],name,subject,assignments};
    } else {
      _teachers.push({id:teacherId,name,subject,assignments,createdAt:new Date().toISOString()});
    }
    await StorageEngine.save('teachers', _teachers);
    window._closeModal('teacher-form-modal');
    renderTeachersGrid();
    notify(editId?'✅ تم تعديل بيانات المدرس':'✅ تم إضافة المدرس بنجاح','success');
  }

  async function deleteTeacher(id){
    if(!confirm('هل أنت متأكد من حذف هذا المدرس وكل بياناته؟')) return;
    _teachers=_teachers.filter(t=>t.id!==id);
    await StorageEngine.delete('teachers',id);
    // delete logs
    const logIds=_logs.filter(l=>l.teacherId===id).map(l=>l.id);
    for(const k of logIds) await _delFrom('teacherLogs',k);
    _logs=_logs.filter(l=>l.teacherId!==id);
    renderTeachersGrid();
    notify('✅ تم حذف المدرس','success');
  }

  // ══════════════════════════════════════════════════════════
  //  TEACHER ACCOUNT VIEW
  // ══════════════════════════════════════════════════════════
  function openTeacherAccount(teacherId){
    _activeTeacherId=teacherId;
    const t=_teachers.find(x=>x.id===teacherId);
    if(!t) return;
    const accountEl=document.getElementById('teacher-account-view');
    const gridEl=document.getElementById('teachers-grid-view');
    if(accountEl) accountEl.style.display='block';
    if(gridEl) gridEl.style.display='none';
    renderTeacherAccount(t);
  }

  function backToTeachersList(){
    _activeTeacherId=null;
    document.getElementById('teacher-account-view')?.style.setProperty('display','none');
    document.getElementById('teachers-grid-view')?.style.setProperty('display','block');
    renderTeachersGrid();
  }

  function renderTeacherAccount(t){
    const el=document.getElementById('teacher-account-content');
    if(!el) return;

    const {from,to}=_dateRange();
    const allLogs=_logs.filter(l=>l.teacherId===t.id);
    const filteredLogs=allLogs.filter(l=>_inRange(l.date,from,to));
    const attendedLogs=filteredLogs.filter(l=>l.status==='attended');
    const absentLogs=filteredLogs.filter(l=>l.status==='absent');
    const cancelledLogs=filteredLogs.filter(l=>l.status==='cancelled');

    const totalDue=_calcDue(t.id,attendedLogs);
    const totalPaid=_calcPaid(t.id);
    const totalAdv=_calcAdvances(t.id);
    const remaining=Math.max(0,totalDue-totalPaid-totalAdv);

    // Weekly schedule from HallsModule
    const tLessons=_teacherLessons(t.id);
    const todayKey=DAY_KEYS[new Date().getDay()];
    const todaySessions=tLessons.filter(l=>l.day===todayKey);
    const today=new Date().toISOString().split('T')[0];
    const todayLogsDone=_logs.filter(l=>l.teacherId===t.id&&l.date?.startsWith(today));

    // Breakdown by assignment + session detail
    const breakdown=(t.assignments||[]).map(a=>{
      const gl=gLabel(a.grade);
      const grp=grpName(a.groupId);
      const sessLogs=attendedLogs.filter(l=>String(l.grade)===String(a.grade)&&
        (String(l.groupId)===String(a.groupId)||!a.groupId||!l.groupId));
      return {label:`${gl} — ${grp}`,price:a.pricePerSession||0,count:sessLogs.length,subtotal:sessLogs.length*(a.pricePerSession||0),logs:sessLogs};
    });

    el.innerHTML=`
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap;">
        <button onclick="TeachersModule.backToTeachersList()"
          style="background:var(--bg-light);border:1px solid var(--border);border-radius:10px;padding:0.5rem 1rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-arrow-right"></i> رجوع
        </button>
        <div style="flex:1;">
          <h2 style="margin:0;font-size:1.25rem;font-weight:800;color:var(--primary);">${_esc(t.name)}</h2>
          <span style="color:var(--text-muted);font-size:0.85rem;">${_esc(t.subject||'')}</span>
        </div>
        <button onclick="TeachersModule.showAddTeacherModal(${t.id})"
          style="background:var(--bg-light);border:1px solid var(--border);border-radius:10px;padding:0.5rem 1rem;cursor:pointer;">
          <i class="fas fa-edit"></i> تعديل
        </button>
        <button onclick="TeachersModule.showPayoutModal(${t.id})"
          style="background:linear-gradient(135deg,#16a34a,#15803d);color:white;border:none;border-radius:10px;padding:0.5rem 1.2rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-hand-holding-usd"></i> صرف مستحقات
        </button>
        <button onclick="TeachersModule.showAdvanceModal(${t.id})"
          style="background:linear-gradient(135deg,#f59e0b,#d97706);color:white;border:none;border-radius:10px;padding:0.5rem 1.1rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-coins"></i> سلفة
        </button>
      </div>

      <!-- Date filter -->
      <div style="display:flex;gap:0.4rem;margin-bottom:1.4rem;flex-wrap:wrap;align-items:center;">
        ${['today','week','month','custom'].map(k=>`
          <button onclick="TeachersModule.setFilter('${k}')"
            style="padding:0.4rem 0.9rem;border-radius:20px;border:1.5px solid var(--border);cursor:pointer;font-size:0.8rem;font-weight:700;
              background:${_dateFilter===k?'var(--primary)':'var(--bg-white)'};
              color:${_dateFilter===k?'white':'var(--text-muted)'};">
            ${{today:'اليوم',week:'الأسبوع',month:'الشهر',custom:'مخصص'}[k]}
          </button>`).join('')}
        ${_dateFilter==='custom'?`
          <input type="date" id="cf" value="${_customFrom||''}" onchange="TeachersModule.setCustomRange()"
            style="border-radius:8px;border:1px solid var(--border);padding:4px 8px;font-size:0.8rem;">
          <span style="color:var(--text-muted);">→</span>
          <input type="date" id="ct" value="${_customTo||''}" onchange="TeachersModule.setCustomRange()"
            style="border-radius:8px;border:1px solid var(--border);padding:4px 8px;font-size:0.8rem;">`:''}
      </div>

      <!-- Main stats -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:0.75rem;margin-bottom:1.4rem;">
        ${[
          {label:'حصص مُنجزة',val:attendedLogs.length,color:'#16a34a',icon:'fas fa-check-circle'},
          {label:'غياب',val:absentLogs.length,color:'#ef4444',icon:'fas fa-times-circle'},
          {label:'ملغاة',val:cancelledLogs.length,color:'#6b7280',icon:'fas fa-ban'},
          {label:'إجمالي المستحقات',val:totalDue.toLocaleString('ar-EG')+' ج',color:'#4f46e5',icon:'fas fa-coins'},
          {label:'السلف',val:totalAdv.toLocaleString('ar-EG')+' ج',color:'#f59e0b',icon:'fas fa-hand-holding-usd'},
          {label:'المدفوع',val:totalPaid.toLocaleString('ar-EG')+' ج',color:'#0ea5e9',icon:'fas fa-money-bill-wave'},
          {label:'المتبقي',val:remaining.toLocaleString('ar-EG')+' ج',color:remaining>0?'#ef4444':'#16a34a',icon:'fas fa-wallet'},
        ].map(s=>`
          <div style="background:var(--bg-white);border-radius:13px;padding:0.9rem;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
            <i class="${s.icon}" style="color:${s.color};font-size:1.2rem;display:block;margin-bottom:5px;"></i>
            <div style="font-size:1.1rem;font-weight:800;color:${s.color};">${s.val}</div>
            <div style="font-size:0.68rem;color:var(--text-muted);">${s.label}</div>
          </div>`).join('')}
      </div>

      <!-- Today's Sessions -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-day" style="margin-left:6px;"></i> حصص اليوم (${todaySessions.length})
        </h3>
        ${todaySessions.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;">لا توجد حصص مجدولة اليوم.</p>`
          :todaySessions.map(s=>{
            const log=todayLogsDone.find(l=>l.lessonId===s.id||
              (l.grade===s.grade&&l.groupId===s.groupId&&l.date?.startsWith(today)));
            const hallN=hallName(s.hallId);
            const grp=grpName(s.groupId);
            const gl=gLabel(s.grade);
            const statusBadge={
              attended:`<span style="color:#16a34a;font-weight:700;padding:2px 8px;background:#f0fdf4;border-radius:8px;font-size:0.75rem;">✓ حضر</span>`,
              absent:`<span style="color:#ef4444;font-weight:700;padding:2px 8px;background:#fef2f2;border-radius:8px;font-size:0.75rem;">✕ غائب</span>`,
              postponed:`<span style="color:#f59e0b;font-weight:700;padding:2px 8px;background:#fffbeb;border-radius:8px;font-size:0.75rem;">⏸ مؤجّل</span>`,
              cancelled:`<span style="color:#6b7280;font-weight:700;padding:2px 8px;background:#f9fafb;border-radius:8px;font-size:0.75rem;">✕ ملغي</span>`,
            };
            return `
              <div style="padding:0.85rem;border:1.5px solid var(--border);border-radius:12px;margin-bottom:0.5rem;">
                <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
                  <div style="flex:1;min-width:140px;">
                    <div style="font-weight:700;font-size:0.9rem;">${s.timeFrom}–${s.timeTo}</div>
                    <div style="font-size:0.78rem;color:var(--text-muted);">${gl} · ${grp} · <span style="color:#8b5cf6;">${hallN}</span></div>
                  </div>
                  <div>${log?(statusBadge[log.status]||''):'<span style="color:var(--text-muted);font-size:0.78rem;">لم يُسجَّل</span>'}</div>
                  <div style="display:flex;gap:5px;flex-wrap:wrap;">
                    ${['attended','absent','postponed','cancelled'].map(st=>`
                      <button onclick="TeachersModule.logSession(${t.id},'${s.id}','${st}','${s.grade}','${s.groupId||''}','${s.hallId||''}')"
                        style="padding:4px 9px;border:none;border-radius:7px;cursor:pointer;font-weight:700;font-size:0.75rem;
                          background:${{attended:'#dcfce7',absent:'#fef2f2',postponed:'#fefce8',cancelled:'#f9fafb'}[st]};
                          color:${{attended:'#16a34a',absent:'#ef4444',postponed:'#f59e0b',cancelled:'#6b7280'}[st]};">
                        ${{attended:'✓ حضر',absent:'✕ غياب',postponed:'تأجيل',cancelled:'إلغاء'}[st]}
                      </button>`).join('')}
                  </div>
                </div>
              </div>`;
          }).join('')}
      </div>

      <!-- Detailed Session Statement -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-file-invoice" style="margin-left:6px;"></i> كشف الحصص التفصيلي
        </h3>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:0.82rem;min-width:600px;">
            <thead>
              <tr style="background:var(--bg-light);">
                <th style="padding:8px 10px;text-align:right;border-radius:8px 0 0 8px;">التاريخ</th>
                <th style="padding:8px 10px;text-align:center;">المجموعة</th>
                <th style="padding:8px 10px;text-align:center;">المادة</th>
                <th style="padding:8px 10px;text-align:center;">القاعة</th>
                <th style="padding:8px 10px;text-align:center;">عدد الحصص</th>
                <th style="padding:8px 10px;text-align:center;">سعر الحصة</th>
                <th style="padding:8px 10px;text-align:left;border-radius:0 8px 8px 0;">القيمة</th>
              </tr>
            </thead>
            <tbody>
              ${breakdown.map(b=>`
                ${b.logs.map(lg=>`
                  <tr style="border-bottom:1px solid var(--bg-light);">
                    <td style="padding:7px 10px;">${new Date(lg.date).toLocaleDateString('ar-EG')}</td>
                    <td style="padding:7px 10px;text-align:center;">${_esc(grpName(lg.groupId))}</td>
                    <td style="padding:7px 10px;text-align:center;">${_esc(t.subject||gLabel(lg.grade))}</td>
                    <td style="padding:7px 10px;text-align:center;">${_esc(hallName(lg.hallId||''))}</td>
                    <td style="padding:7px 10px;text-align:center;">1</td>
                    <td style="padding:7px 10px;text-align:center;">${b.price.toLocaleString('ar-EG')} ج</td>
                    <td style="padding:7px 10px;text-align:left;font-weight:700;color:var(--primary);">${b.price.toLocaleString('ar-EG')} ج</td>
                  </tr>`).join('')}`).join('')}
              ${attendedLogs.length===0?`
                <tr><td colspan="7" style="padding:1.5rem;text-align:center;color:var(--text-muted);">لا توجد حصص مسجّلة في هذه الفترة</td></tr>`:''}
            </tbody>
            <tfoot>
              <tr style="background:var(--bg-light);font-weight:800;">
                <td colspan="4" style="padding:9px 10px;border-radius:8px 0 0 8px;">الإجمالي (${attendedLogs.length} حصة)</td>
                <td style="padding:9px 10px;text-align:center;">${attendedLogs.length}</td>
                <td style="padding:9px 10px;text-align:center;">---</td>
                <td style="padding:9px 10px;text-align:left;color:var(--primary);font-size:0.95rem;border-radius:0 8px 8px 0;">${totalDue.toLocaleString('ar-EG')} ج</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- Financial Summary -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calculator" style="margin-left:6px;"></i> ملخص الحساب المالي
        </h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem;">
          ${[
            {label:'إجمالي المستحقات',val:totalDue,color:'#4f46e5',bg:'#eff6ff'},
            {label:'السلف المأخوذة',val:totalAdv,color:'#f59e0b',bg:'#fffbeb'},
            {label:'المدفوع',val:totalPaid,color:'#0ea5e9',bg:'#f0f9ff'},
            {label:'المتبقي',val:remaining,color:remaining>0?'#ef4444':'#16a34a',bg:remaining>0?'#fef2f2':'#f0fdf4'},
          ].map(s=>`
            <div style="background:${s.bg};border-radius:12px;padding:1rem;text-align:center;">
              <div style="font-size:1.4rem;font-weight:800;color:${s.color};">${s.val.toLocaleString('ar-EG')} ج</div>
              <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">${s.label}</div>
            </div>`).join('')}
        </div>
      </div>

      <!-- Weekly Schedule from Hall System -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-week" style="margin-left:6px;"></i> الجدول الأسبوعي
        </h3>
        ${tLessons.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;">لم يتم إضافة حصص في نظام القاعات بعد. <a href="#" onclick="showSection('halls',document.getElementById('nav-halls'))" style="color:var(--primary);">انتقل إلى القاعات</a> لإضافة حصص.</p>`
          :`<div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:0.82rem;min-width:500px;">
                <thead>
                  <tr style="background:var(--bg-light);">
                    <th style="padding:8px;text-align:right;">اليوم</th>
                    <th style="padding:8px;text-align:center;">الوقت</th>
                    <th style="padding:8px;text-align:center;">المادة</th>
                    <th style="padding:8px;text-align:center;">الصف</th>
                    <th style="padding:8px;text-align:center;">المجموعة</th>
                    <th style="padding:8px;text-align:center;">القاعة</th>
                  </tr>
                </thead>
                <tbody>
                  ${tLessons.sort((a,b)=>DAY_KEYS.indexOf(a.day)-DAY_KEYS.indexOf(b.day)||toMin(a.timeFrom)-toMin(b.timeFrom)).map(l=>`
                    <tr style="border-bottom:1px solid var(--bg-light);">
                      <td style="padding:8px;font-weight:700;">${ARABIC_DAYS[DAY_KEYS.indexOf(l.day)]||l.day}</td>
                      <td style="padding:8px;text-align:center;">${l.timeFrom}–${l.timeTo}</td>
                      <td style="padding:8px;text-align:center;">${_esc(l.subject||gLabel(l.grade))}</td>
                      <td style="padding:8px;text-align:center;">${_esc(gLabel(l.grade))}</td>
                      <td style="padding:8px;text-align:center;">${_esc(grpName(l.groupId))}</td>
                      <td style="padding:8px;text-align:center;font-weight:700;color:#8b5cf6;">${_esc(hallName(l.hallId))}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>`}
      </div>

      <!-- Advances Record -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-coins" style="margin-left:6px;"></i> سجل السلف (${totalAdv.toLocaleString('ar-EG')} ج)
        </h3>
        ${_renderAdvancesTable(t.id)}
      </div>

      <!-- Payouts Record -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-receipt" style="margin-left:6px;"></i> سجل المدفوعات (${totalPaid.toLocaleString('ar-EG')} ج)
        </h3>
        ${_renderPayoutsTable(t.id)}
      </div>
    `;
  }

  function toMin(t){ const[h,m]=(t||'00:00').split(':').map(Number); return h*60+(m||0); }

  function _renderPayoutsTable(tid){
    const payouts=_payouts.filter(p=>p.teacherId===tid).sort((a,b)=>new Date(b.date)-new Date(a.date));
    if(!payouts.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">لا توجد مدفوعات مسجّلة بعد.</p>';
    return `
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
        <thead><tr style="background:var(--bg-light);">
          <th style="padding:8px;text-align:right;">التاريخ</th>
          <th style="padding:8px;text-align:center;">المبلغ (ج)</th>
          <th style="padding:8px;text-align:right;">ملاحظات</th>
          <th style="padding:8px;"></th>
        </tr></thead>
        <tbody>
          ${payouts.map(p=>`
            <tr style="border-bottom:1px solid var(--bg-light);">
              <td style="padding:8px;">${new Date(p.date).toLocaleDateString('ar-EG')}</td>
              <td style="padding:8px;text-align:center;font-weight:800;color:#16a34a;">${(p.amount||0).toLocaleString('ar-EG')}</td>
              <td style="padding:8px;color:var(--text-muted);">${_esc(p.notes||'—')}</td>
              <td style="padding:8px;">
                <button onclick="TeachersModule.deletePayout(${p.id})"
                  style="background:#fef2f2;border:none;border-radius:6px;padding:3px 8px;cursor:pointer;color:#ef4444;font-size:0.75rem;">
                  <i class="fas fa-trash"></i>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function _renderAdvancesTable(tid){
    const advs=_advances.filter(a=>a.teacherId===tid).sort((a,b)=>new Date(b.date)-new Date(a.date));
    if(!advs.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">لا توجد سلف مسجّلة.</p>';
    return `
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
        <thead><tr style="background:var(--bg-light);">
          <th style="padding:8px;text-align:right;">التاريخ</th>
          <th style="padding:8px;text-align:center;">المبلغ (ج)</th>
          <th style="padding:8px;text-align:right;">السبب</th>
          <th style="padding:8px;"></th>
        </tr></thead>
        <tbody>
          ${advs.map(a=>`
            <tr style="border-bottom:1px solid var(--bg-light);">
              <td style="padding:8px;">${new Date(a.date).toLocaleDateString('ar-EG')}</td>
              <td style="padding:8px;text-align:center;font-weight:800;color:#f59e0b;">${(a.amount||0).toLocaleString('ar-EG')}</td>
              <td style="padding:8px;color:var(--text-muted);">${_esc(a.reason||'—')}</td>
              <td style="padding:8px;">
                <button onclick="TeachersModule.deleteAdvance(${a.id})"
                  style="background:#fef2f2;border:none;border-radius:6px;padding:3px 8px;cursor:pointer;color:#ef4444;font-size:0.75rem;">
                  <i class="fas fa-trash"></i>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ── Log Session ──
  async function logSession(teacherId, lessonId, status, grade, groupId, hallId=''){
    const today=new Date().toISOString().split('T')[0];
    const old=_logs.find(l=>l.teacherId===teacherId&&l.lessonId===lessonId&&l.date?.startsWith(today));
    if(old){ _logs=_logs.filter(l=>l.id!==old.id); await _delFrom('teacherLogs',old.id); }

    const log={id:Date.now(),teacherId,lessonId,status,grade,groupId:groupId||null,hallId:hallId||null,date:new Date().toISOString()};
    _logs.push(log);
    await StorageEngine.save('teacherLogs', log);
    notify({attended:'✓ تم تسجيل الحضور',absent:'✕ تم تسجيل الغياب',postponed:'⏸ تم تسجيل التأجيل',cancelled:'تم إلغاء الحصة'}[status]||'تم التسجيل','success');
    const t=_teachers.find(x=>x.id===teacherId);
    if(t) renderTeacherAccount(t);
  }

  // ── Payout Modal ──
  function showPayoutModal(tid){
    const t=_teachers.find(x=>x.id===tid);
    if(!t) return;
    const totalDue=_calcDue(tid);
    const totalPaid=_calcPaid(tid);
    const totalAdv=_calcAdvances(tid);
    const remaining=Math.max(0,totalDue-totalPaid-totalAdv);

    const modal=_mkModal('payout-modal',`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;">
        <h2 style="margin:0;color:var(--primary);font-size:1.1rem;font-weight:800;">
          <i class="fas fa-hand-holding-usd" style="margin-left:8px;"></i> صرف مستحقات: ${_esc(t.name)}
        </h2>
        <button onclick="window._closeModal('payout-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0.6rem;margin-bottom:1.2rem;text-align:center;">
        ${[
          {label:'الإجمالي',val:totalDue,color:'#4f46e5',bg:'#eff6ff'},
          {label:'السلف',val:totalAdv,color:'#f59e0b',bg:'#fffbeb'},
          {label:'المدفوع',val:totalPaid,color:'#0ea5e9',bg:'#f0f9ff'},
          {label:'المتبقي',val:remaining,color:remaining>0?'#ef4444':'#16a34a',bg:remaining>0?'#fef2f2':'#f0fdf4'},
        ].map(s=>`
          <div style="background:${s.bg};border-radius:10px;padding:0.7rem;">
            <div style="font-size:1rem;font-weight:800;color:${s.color};">${s.val.toLocaleString('ar-EG')}</div>
            <div style="font-size:0.68rem;color:var(--text-muted);">${s.label}</div>
          </div>`).join('')}
      </div>
      <div style="display:grid;gap:0.75rem;margin-bottom:1.2rem;">
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">المبلغ المدفوع (ج) *</label>
          <input id="po-amount" type="number" min="0" class="form-input" value="${remaining>0?remaining:''}" placeholder="أدخل المبلغ">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">تاريخ الدفع</label>
          <input id="po-date" type="date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">ملاحظات (اختياري)</label>
          <input id="po-notes" type="text" class="form-input" placeholder="مثال: دفع نهاية الشهر">
        </div>
      </div>
      <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
        <button onclick="window._closeModal('payout-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._confirmPayout(${tid})" class="btn btn-primary" style="border-radius:10px;padding:0.6rem 2rem;">
          <i class="fas fa-check"></i> تأكيد الصرف
        </button>
      </div>
    `);
    document.body.appendChild(modal);
  }

  async function _confirmPayout(tid){
    const amount=parseFloat(document.getElementById('po-amount')?.value);
    const date=document.getElementById('po-date')?.value;
    const notes=document.getElementById('po-notes')?.value.trim();
    if(!amount||amount<=0) return notify('يرجى إدخال مبلغ صحيح','error');
    if(!date) return notify('يرجى اختيار تاريخ','error');
    const p={id:Date.now(),teacherId:tid,amount,date,notes};
    _payouts.push(p);
    await StorageEngine.save('teacherPayouts', p);
    window._closeModal('payout-modal');
    notify(`✅ تم تسجيل دفعة ${amount.toLocaleString('ar-EG')} ج`,'success');
    const t=_teachers.find(x=>x.id===tid);
    if(t) renderTeacherAccount(t);
  }

  async function deletePayout(id){
    if(!confirm('حذف هذه الدفعة؟')) return;
    _payouts=_payouts.filter(p=>p.id!==id);
    await _delFrom('teacherPayouts',id);
    notify('تم حذف الدفعة');
    if(_activeTeacherId){ const t=_teachers.find(x=>x.id===_activeTeacherId); if(t) renderTeacherAccount(t); }
  }

  // ── Advance Modal ──
  function showAdvanceModal(tid){
    const t=_teachers.find(x=>x.id===tid);
    if(!t) return;
    const modal=_mkModal('advance-modal',`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;">
        <h2 style="margin:0;color:#f59e0b;font-size:1.1rem;font-weight:800;">
          <i class="fas fa-coins" style="margin-left:8px;"></i> تسجيل سلفة: ${_esc(t.name)}
        </h2>
        <button onclick="window._closeModal('advance-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>
      <div style="display:grid;gap:0.75rem;margin-bottom:1.2rem;">
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">مبلغ السلفة (ج) *</label>
          <input id="adv-amount" type="number" min="0" class="form-input" placeholder="أدخل المبلغ">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">التاريخ</label>
          <input id="adv-date" type="date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">السبب (اختياري)</label>
          <input id="adv-reason" type="text" class="form-input" placeholder="مثال: سلفة طارئة">
        </div>
      </div>
      <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
        <button onclick="window._closeModal('advance-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._confirmAdvance(${tid})" class="btn" style="border-radius:10px;padding:0.6rem 2rem;background:#f59e0b;color:white;border:none;font-weight:700;">
          <i class="fas fa-check"></i> تأكيد السلفة
        </button>
      </div>
    `);
    document.body.appendChild(modal);
  }

  async function _confirmAdvance(tid){
    const amount=parseFloat(document.getElementById('adv-amount')?.value);
    const date=document.getElementById('adv-date')?.value;
    const reason=document.getElementById('adv-reason')?.value.trim();
    if(!amount||amount<=0) return notify('يرجى إدخال مبلغ صحيح','error');
    const adv={id:Date.now(),teacherId:tid,amount,date,reason};
    _advances.push(adv);
    await StorageEngine.save('teacherAdvances', adv);
    window._closeModal('advance-modal');
    notify(`✅ تم تسجيل سلفة ${amount.toLocaleString('ar-EG')} ج`,'success');
    const t=_teachers.find(x=>x.id===tid);
    if(t) renderTeacherAccount(t);
  }

  async function deleteAdvance(id){
    if(!confirm('حذف هذه السلفة؟')) return;
    _advances=_advances.filter(a=>a.id!==id);
    await _delFrom('teacherAdvances',id);
    notify('تم حذف السلفة');
    if(_activeTeacherId){ const t=_teachers.find(x=>x.id===_activeTeacherId); if(t) renderTeacherAccount(t); }
  }

  // ── Filters ──
  function setFilter(f){
    _dateFilter=f;
    if(_activeTeacherId){ const t=_teachers.find(x=>x.id===_activeTeacherId); if(t) renderTeacherAccount(t); }
  }
  function setCustomRange(){
    _customFrom=document.getElementById('cf')?.value||null;
    _customTo=document.getElementById('ct')?.value||null;
    if(_activeTeacherId){ const t=_teachers.find(x=>x.id===_activeTeacherId); if(t) renderTeacherAccount(t); }
  }

  // ── Build options ──
  function _buildGradeOpts(sel=''){
    if(typeof GRADE_MAP==='undefined'&&window.gradesList)
      return (window.gradesList||[]).map(g=>`<option value="${_esc(String(g.id))}" ${String(g.id)===String(sel)?'selected':''}>${_esc(g.name)}</option>`).join('');
    if(typeof GRADE_MAP!=='undefined')
      return GRADE_MAP.map(g=>`<option value="${g.systemCode}" ${g.systemCode===sel?'selected':''}>${g.label}</option>`).join('');
    return '';
  }
  function _buildGroupOpts(grade='',selId=''){
    const groups=(window.db&&db.groups)||[];
    const filtered=grade?groups.filter(g=>String(g.grade)===String(grade)):groups;
    return filtered.map(g=>`<option value="${g.id}" ${String(g.id)===String(selId)?'selected':''}>${_esc(g.name)}</option>`).join('');
  }

  // ── Modal factory ──
  function _mkModal(id,content){
    const ex=document.getElementById(id); if(ex) ex.remove();
    const m=document.createElement('div');
    m.id=id;
    m.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);overflow-y:auto;';
    m.innerHTML=`<div style="background:var(--bg-white,#fff);border-radius:20px;padding:2rem;max-width:680px;width:95%;max-height:92vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,0.3);direction:rtl;font-family:inherit;margin:auto;">${content}</div>`;
    m.addEventListener('click',e=>{if(e.target===m)m.remove();});
    return m;
  }

  window._closeModal=function(id){ const el=document.getElementById(id); if(el) el.remove(); };

  // ── Public API ──
  window.TeachersModule = {
    initTeachersSection,
    renderTeachersGrid,
    showAddTeacherModal,
    showEditTeacherModal,
    deleteTeacher,
    openTeacherAccount,
    backToTeachersList,
    logSession,
    showPayoutModal,
    showAdvanceModal,
    deletePayout,
    deleteAdvance,
    setFilter,
    setCustomRange,
    _addAssignRow,
    _onGradeChange,
    _saveTeacher,
    _confirmPayout,
    _confirmAdvance,
  };

  console.log('[teachers.js] v2.0 ✅ نظام حسابات المدرسين المتكامل جاهز');
})();
