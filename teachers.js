// ============================================================
//  teachers.js  v4.0 — نظام حسابات المدرسين المتكامل
//  التطوير: جدول حضور شهري + تسجيل بتاريخ مخصص + مستحقات شهرية
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
  let _monthlyDues = []; // سجل المستحقات الشهرية المرحّلة
  let _activeTeacherId = null;
  let _dateFilter = 'month';
  let _customFrom = null;
  let _customTo   = null;

  // ── DB helpers ──
  async function loadAll(){
    if(typeof StorageEngine==='undefined') return;
    _teachers    = await _safe('teachers');
    _logs        = await _safe('teacherLogs');
    _payouts     = await _safe('teacherPayouts');
    _advances    = await _safe('teacherAdvances');
    _monthlyDues = await _safe('teacherMonthlyDues');
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
      const needed=['teachers','teacherLogs','teacherPayouts','teacherAdvances','teacherMonthlyDues'];
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
  function _esc(s){ return String(s||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
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
  function _gradeKey(value){
    const raw = String(value || '').trim();
    if(!raw) return '';
    if(Array.isArray(window.CATEGORY_TABLE)){
      const bySystemCode = window.CATEGORY_TABLE.find(c => String(c.systemCode) === raw);
      if(bySystemCode) return `cat:${bySystemCode.categoryId}`;
    }
    if(typeof toCategoryId === 'function'){
      const categoryId = toCategoryId(raw);
      if(categoryId) return `cat:${categoryId}`;
    }
    if(typeof gradeIdToSystemCode === 'function'){
      const sysCode = gradeIdToSystemCode(raw);
      if(sysCode && sysCode !== raw && typeof toCategoryId === 'function'){
        const categoryId = toCategoryId(sysCode);
        if(categoryId) return `cat:${categoryId}`;
      }
      if(sysCode) return `sys:${sysCode}`;
    }
    const gradeObj = (window.gradesList || []).find(g =>
      String(g.id) === raw ||
      String(g.systemCode || '') === raw ||
      String(g.name || g.label || '') === raw
    );
    if(gradeObj){
      const candidate = gradeObj.systemCode || gradeObj.id || gradeObj.name || gradeObj.label;
      if(typeof toCategoryId === 'function'){
        const categoryId = toCategoryId(candidate);
        if(categoryId) return `cat:${categoryId}`;
      }
      return `sys:${candidate}`;
    }
    return `raw:${raw}`;
  }
  function _sameGrade(a,b){
    const ak = _gradeKey(a);
    const bk = _gradeKey(b);
    return !!ak && !!bk && ak === bk;
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

  // ── حساب قيمة الحصة من تخصيصات المدرس (حسب المجموعة) ──
  function _getPriceForLog(teacher, log){
    if(!teacher) return 0;
    const assignments = teacher.assignments || [];
    // بحث مطابق بالصف والمجموعة
    let match = assignments.find(a =>
      String(a.grade) === String(log.grade) &&
      String(a.groupId||'') === String(log.groupId||'')
    );
    // بحث بالصف فقط لو ما لقيناش بالمجموعة
    if(!match) match = assignments.find(a => String(a.grade) === String(log.grade));
    return match ? (match.pricePerSession || 0) : 0;
  }

  // ── Calculate financials ──
  function _calcDue(teacherId, logs=null){
    const t=_teachers.find(x=>x.id===teacherId);
    if(!t) return 0;
    const useLogs=logs||_logs.filter(l=>l.teacherId===teacherId&&l.status==='attended');
    return useLogs.reduce((sum,l)=>{
      const price = _getPriceForLog(t, l);
      return sum+(price||0);
    },0);
  }

  function _calcPaid(teacherId){ return _payouts.filter(p=>p.teacherId===teacherId).reduce((s,p)=>s+(p.amount||0),0); }
  function _calcAdvances(teacherId){ return _advances.filter(a=>a.teacherId===teacherId).reduce((s,a)=>s+(a.amount||0),0); }

  // ── حساب مستحقات شهر معين ──
  function _calcMonthDue(teacherId, yearMonth){
    const t=_teachers.find(x=>x.id===teacherId);
    if(!t) return 0;
    const monthLogs = _logs.filter(l =>
      l.teacherId===teacherId &&
      l.status==='attended' &&
      (l.date||'').substring(0,7) === yearMonth
    );
    return monthLogs.reduce((sum,l)=>{
      const price = _getPriceForLog(t, l);
      return sum+(price||0);
    },0);
  }

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

          ${todayLessons.length>0?`
            <div style="background:#f0f9ff;border-radius:8px;padding:0.5rem 0.75rem;margin-bottom:0.75rem;font-size:0.75rem;">
              <span style="color:#0ea5e9;font-weight:700;"><i class="fas fa-calendar-day" style="margin-left:3px;"></i>اليوم: ${todayLessons.length} حصة</span>
              ${todayLessons.map(l=>`<span style="color:var(--text-muted);margin-right:8px;">${l.timeFrom}–${l.timeTo}</span>`).join('')}
            </div>`:``}

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
  const DAY_DISPLAY_ORDER = ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];
  const DAY_LABEL = {};
  DAY_KEYS.forEach((k,i)=>{ DAY_LABEL[k]=ARABIC_DAYS[i]; });

  let _formBlocks = [];
  let _formSelectedGrades = new Set();

  function _uid(){ return 'b'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

  function _buildFormStateFromTeacher(t){
    const assignments=(t&&t.assignments)||[];
    const allLessons=(window.HallsModule?HallsModule.getLessons():[]).filter(l=>String(l.teacherId)===String(t?.id));
    const blocks=[];
    const covered=new Set();

    assignments.forEach(a=>{
      const key=`${a.grade}||${a.groupId||''}`;
      covered.add(key);
      const slots=allLessons.filter(l=>String(l.grade)===String(a.grade)&&String(l.groupId||'')===String(a.groupId||''))
        .map(l=>({day:l.day,from:l.timeFrom||'',to:l.timeTo||''}));
      blocks.push({
        uid:_uid(), grade:String(a.grade), groupId:a.groupId||null,
        groupName:a.groupId?grpName(a.groupId):'', price:a.pricePerSession||'',
        slots
      });
    });

    const extraKeys=new Set();
    allLessons.forEach(l=>{
      const key=`${l.grade}||${l.groupId||''}`;
      if(!covered.has(key)) extraKeys.add(key);
    });
    extraKeys.forEach(key=>{
      const sep=key.indexOf('||');
      const grade=key.slice(0,sep), groupIdRaw=key.slice(sep+2);
      const groupId=groupIdRaw||null;
      const slots=allLessons.filter(l=>String(l.grade)===grade&&String(l.groupId||'')===String(groupId||''))
        .map(l=>({day:l.day,from:l.timeFrom||'',to:l.timeTo||''}));
      blocks.push({ uid:_uid(), grade, groupId, groupName:groupId?grpName(groupId):'', price:'', slots });
    });

    return blocks;
  }

  function showAddTeacherModal(editId=null){
    const t=editId?_teachers.find(x=>x.id===editId):null;
    _formBlocks=t?_buildFormStateFromTeacher(t):[];
    _formSelectedGrades=new Set(_formBlocks.map(b=>String(b.grade)));

    const modal=_mkModalWide('teacher-form-modal',`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
        <h2 style="margin:0;color:var(--primary);font-size:1.15rem;font-weight:800;">
          <i class="fas fa-chalkboard-teacher" style="margin-left:8px;"></i>
          ${editId?'تعديل بيانات المدرس':'إضافة مدرس جديد'}
        </h2>
        <button onclick="window._closeModal('teacher-form-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;flex-shrink:0;"><i class="fas fa-times"></i></button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.3rem;">
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">اسم المدرس *</label>
          <input id="t-name" type="text" class="form-input" value="${_esc(t?.name||'')}" placeholder="مثال: أحمد محمد">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">المادة *</label>
          <input id="t-subject" type="text" class="form-input" value="${_esc(t?.subject||'')}" placeholder="مثال: الفيزياء">
        </div>
      </div>

      <div style="margin-bottom:1.3rem;">
        <label style="font-weight:700;font-size:0.9rem;display:block;margin-bottom:0.6rem;">
          <i class="fas fa-layer-group" style="color:var(--primary);margin-left:5px;"></i>الصفوف الدراسية (يمكن اختيار أكثر من صف)
        </label>
        <div id="t-grades-checks" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.5rem;">
          ${_renderGradeCheckboxes()}
        </div>
      </div>

      <div id="t-grade-blocks">
        ${_renderGradeBlocks()}
      </div>

      <div id="t-conflict-zone" style="display:none;margin-top:1rem;"></div>

      <div style="display:flex;gap:0.75rem;justify-content:flex-end;margin-top:1.5rem;">
        <button onclick="window._closeModal('teacher-form-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._saveTeacher(${editId||'null'})" class="btn btn-primary" style="border-radius:10px;padding:0.6rem 2rem;">
          <i class="fas fa-save"></i> حفظ
        </button>
      </div>
    `);
    document.body.appendChild(modal);
    _checkFormConflicts(true);
  }

  function showEditTeacherModal(id){ showAddTeacherModal(id); }

  function _renderGradeCheckboxes(){
    const list=Array.isArray(window.gradesList)?window.gradesList:[];
    return list.map(g=>{
      const gid=String(window.GradeGroupLinkSystem.gradeIdOf(g));
      const checked=_formSelectedGrades.has(gid);
      return `
        <label style="display:flex;align-items:center;gap:8px;padding:0.6rem 0.75rem;border:1.5px solid ${checked?'var(--primary)':'var(--border)'};
          background:${checked?'rgba(37,99,235,0.06)':'var(--bg-white)'};border-radius:10px;cursor:pointer;font-size:0.85rem;font-weight:700;transition:var(--transition);">
          <input type="checkbox" value="${_esc(gid)}" ${checked?'checked':''}
            onchange="TeachersModule._toggleGrade('${gid}',this.checked)" style="width:18px;height:18px;cursor:pointer;flex-shrink:0;">
          ${_esc(g.name)}
        </label>`;
    }).join('');
  }

  function _renderGradeBlocks(){
    if(_formSelectedGrades.size===0){
      return `<p style="color:var(--text-muted);font-size:0.85rem;padding:1rem 0;">اختر صفًا دراسيًا واحدًا على الأقل من الأعلى لتبدأ بإضافة المجموعات ومواعيدها.</p>`;
    }
    return Array.from(_formSelectedGrades).map(gid=>_renderOneGradeBlock(gid)).join('');
  }

  function _renderOneGradeBlock(gid){
    const blocks=_formBlocks.filter(b=>String(b.grade)===String(gid));
    return `
      <div id="t-grade-block-${_esc(gid)}" style="background:var(--bg-light);border-radius:14px;padding:1rem;margin-bottom:1rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;flex-wrap:wrap;gap:0.5rem;">
          <h4 style="margin:0;font-size:0.95rem;font-weight:800;color:var(--text-main);">
            <i class="fas fa-graduation-cap" style="color:var(--primary);margin-left:5px;"></i>${_esc(gLabel(gid))}
          </h4>
          <button onclick="TeachersModule._addGroupBlock('${_esc(gid)}')"
            style="background:var(--primary);color:white;border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:0.8rem;font-weight:700;">
            <i class="fas fa-plus"></i> إضافة مجموعة
          </button>
        </div>
        ${blocks.length===0
          ?`<p style="color:var(--text-muted);font-size:0.82rem;">لا توجد مجموعات بعد لهذا الصف — اضغط "إضافة مجموعة".</p>`
          :blocks.map(b=>_renderGroupBlock(b)).join('')}
      </div>`;
  }

  function _renderGroupBlock(b){
    const suggestions=window.GradeGroupLinkSystem?window.GradeGroupLinkSystem.listGroupNamesForGrade(b.grade):[];
    return `
      <div class="t-group-block" data-uid="${b.uid}" style="background:var(--bg-white);border:1.5px solid var(--border);border-radius:12px;padding:0.9rem;margin-bottom:0.75rem;">
        <div style="display:grid;grid-template-columns:1fr 140px 40px;gap:0.5rem;margin-bottom:0.8rem;align-items:center;">
          <div>
            <input type="text" list="t-group-sugg-${b.uid}" autocomplete="off" placeholder="اسم المجموعة (مثال: مجموعة 1)"
              value="${_esc(b.groupName)}" style="width:100%;padding:0.6rem 0.7rem;border:1.5px solid var(--border);border-radius:9px;font-family:inherit;font-size:0.85rem;box-sizing:border-box;"
              onchange="TeachersModule._updateBlockField('${b.uid}','groupName',this.value)">
            <datalist id="t-group-sugg-${b.uid}">${suggestions.map(n=>`<option value="${_esc(n)}">`).join('')}</datalist>
          </div>
          <input type="number" min="0" placeholder="سعر الحصة (ج)" value="${b.price}"
            style="padding:0.6rem 0.7rem;border:1.5px solid var(--border);border-radius:9px;font-family:inherit;font-size:0.85rem;box-sizing:border-box;height:38px;"
            onchange="TeachersModule._updateBlockField('${b.uid}','price',this.value)">
          <button onclick="TeachersModule._removeGroupBlock('${b.uid}')"
            style="background:#fef2f2;border:none;border-radius:9px;height:38px;cursor:pointer;color:#ef4444;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
        <div style="font-size:0.78rem;font-weight:700;color:var(--text-muted);margin-bottom:6px;">مواعيد المجموعة (اضغط على اليوم لتحديده):</div>
        <div style="display:flex;gap:0.5rem;overflow-x:auto;padding-bottom:4px;">
          ${DAY_DISPLAY_ORDER.map(dk=>_renderDayCard(b,dk)).join('')}
        </div>
      </div>`;
  }

  function _renderDayCard(b,dayKey){
    const slot=b.slots.find(s=>s.day===dayKey);
    const active=!!slot;
    return `
      <div style="flex:0 0 auto;min-width:104px;border:1.5px solid ${active?'var(--primary)':'var(--border)'};
        background:${active?'rgba(37,99,235,0.06)':'var(--bg-white)'};border-radius:10px;padding:0.5rem;text-align:center;">
        <button onclick="TeachersModule._toggleDay('${b.uid}','${dayKey}')"
          style="width:100%;border:none;background:transparent;cursor:pointer;font-weight:800;font-size:0.82rem;
            color:${active?'var(--primary)':'var(--text-main)'};padding:4px 0;">
          ${DAY_LABEL[dayKey]}
        </button>
        ${active?`
          <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
            <input type="time" value="${slot.from||''}" onchange="TeachersModule._updateSlotTime('${b.uid}','${dayKey}','from',this.value)"
              style="width:100%;padding:3px;border:1px solid var(--border);border-radius:6px;font-size:0.75rem;box-sizing:border-box;">
            <input type="time" value="${slot.to||''}" onchange="TeachersModule._updateSlotTime('${b.uid}','${dayKey}','to',this.value)"
              style="width:100%;padding:3px;border:1px solid var(--border);border-radius:6px;font-size:0.75rem;box-sizing:border-box;">
          </div>`:''}
      </div>`;
  }

  function _toggleGrade(gid,checked){
    gid=String(gid);
    if(checked) _formSelectedGrades.add(gid);
    else _formSelectedGrades.delete(gid);
    const checksEl=document.getElementById('t-grades-checks');
    if(checksEl) checksEl.innerHTML=_renderGradeCheckboxes();
    const wrap=document.getElementById('t-grade-blocks');
    if(wrap) wrap.innerHTML=_renderGradeBlocks();
    _checkFormConflicts(true);
  }

  function _addGroupBlock(gid){
    _formBlocks.push({uid:_uid(),grade:String(gid),groupId:null,groupName:'',price:'',slots:[]});
    _rerenderGradeSection(gid);
  }

  function _removeGroupBlock(uid){
    const b=_formBlocks.find(x=>x.uid===uid);
    const grade=b?b.grade:null;
    _formBlocks=_formBlocks.filter(x=>x.uid!==uid);
    if(grade!==null) _rerenderGradeSection(grade);
  }

  function _updateBlockField(uid,field,value){
    const b=_formBlocks.find(x=>x.uid===uid);
    if(!b) return;
    if(field==='price') b.price=parseFloat(value)||0;
    else b[field]=value;
  }

  function _toggleDay(uid,dayKey){
    const b=_formBlocks.find(x=>x.uid===uid);
    if(!b) return;
    const idx=b.slots.findIndex(s=>s.day===dayKey);
    if(idx===-1) b.slots.push({day:dayKey,from:'',to:''});
    else b.slots.splice(idx,1);
    _rerenderGroupBlock(uid);
  }

  function _updateSlotTime(uid,dayKey,which,value){
    const b=_formBlocks.find(x=>x.uid===uid);
    if(!b) return;
    const slot=b.slots.find(s=>s.day===dayKey);
    if(!slot) return;
    slot[which]=value;
    if(which==='from' && value && !slot.to){
      const mins=(toMin(value)+60)%1440;
      slot.to=`${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
      _rerenderGroupBlock(uid);
      return;
    }
    _checkFormConflicts(true);
  }

  function _rerenderGradeSection(gid){
    gid=String(gid);
    const el=document.getElementById('t-grade-block-'+gid);
    if(el){ el.outerHTML=_renderOneGradeBlock(gid); }
    else {
      const wrap=document.getElementById('t-grade-blocks');
      if(wrap) wrap.innerHTML=_renderGradeBlocks();
    }
    _checkFormConflicts(true);
  }

  function _rerenderGroupBlock(uid){
    const b=_formBlocks.find(x=>x.uid===uid);
    if(!b) return;
    const el=document.querySelector('.t-group-block[data-uid="'+uid+'"]');
    if(el) el.outerHTML=_renderGroupBlock(b);
    _checkFormConflicts(true);
  }

  function _findConflicts(){
    const all=[];
    _formBlocks.forEach(b=>{
      if(!_formSelectedGrades.has(String(b.grade))) return;
      b.slots.forEach(s=>{
        if(!s.day||!s.from||!s.to) return;
        if(toMin(s.to)<=toMin(s.from)) return;
        all.push({uid:b.uid,grade:b.grade,groupName:b.groupName||'—',day:s.day,from:s.from,to:s.to});
      });
    });
    const conflicts=[];
    for(let i=0;i<all.length;i++){
      for(let j=i+1;j<all.length;j++){
        const A=all[i],B=all[j];
        if(A.day!==B.day) continue;
        if(toMin(A.from)<toMin(B.to)&&toMin(B.from)<toMin(A.to)) conflicts.push({a:A,b:B});
      }
    }
    return conflicts;
  }

  function _checkFormConflicts(renderInline){
    const conflicts=_findConflicts();
    if(!renderInline) return conflicts;
    const zone=document.getElementById('t-conflict-zone');
    if(!zone) return conflicts;
    if(conflicts.length===0){ zone.style.display='none'; zone.innerHTML=''; return conflicts; }
    zone.style.display='block';
    zone.innerHTML=`
      <div style="background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;padding:0.8rem 1rem;">
        <div style="font-weight:800;color:#991b1b;margin-bottom:6px;">
          <i class="fas fa-exclamation-triangle"></i> يوجد تعارض في جدول المدرس.
        </div>
        ${conflicts.map(c=>`
          <div style="font-size:0.8rem;color:#991b1b;padding:2px 0;">
            • ${DAY_LABEL[c.a.day]}: ${_esc(gLabel(c.a.grade))} (${_esc(c.a.groupName)}) ${c.a.from}–${c.a.to}
            ⟷ ${_esc(gLabel(c.b.grade))} (${_esc(c.b.groupName)}) ${c.b.from}–${c.b.to}
          </div>`).join('')}
      </div>`;
    return conflicts;
  }

  async function _saveTeacher(editId){
    const name=document.getElementById('t-name')?.value.trim();
    const subject=document.getElementById('t-subject')?.value.trim();
    if(!name) return notify('يرجى إدخال اسم المدرس','error');
    if(!subject) return notify('يرجى إدخال المادة','error');
    if(_formSelectedGrades.size===0) return notify('يرجى اختيار صف دراسي واحد على الأقل','error');

    const activeBlocks=_formBlocks.filter(b=>_formSelectedGrades.has(String(b.grade)));
    if(activeBlocks.length===0) return notify('يرجى إضافة مجموعة واحدة على الأقل','error');

    for(const b of activeBlocks){
      if(!String(b.groupName||'').trim()) return notify(`يرجى كتابة اسم المجموعة في صف "${gLabel(b.grade)}"`,'error');
    }
    for(const b of activeBlocks){
      for(const s of b.slots){
        if(!s.from||!s.to) return notify(`يرجى تحديد وقت البداية والنهاية ليوم ${DAY_LABEL[s.day]} في مجموعة "${b.groupName}"`,'error');
        if(toMin(s.to)<=toMin(s.from)) return notify(`وقت نهاية الحصة يجب أن يكون بعد وقت البداية`,'error');
      }
    }

    const conflicts=_checkFormConflicts(true);
    if(conflicts.length>0) return notify('❌ يوجد تعارض في جدول المدرس.','error');

    for(const b of activeBlocks){
      const grp=await window.GradeGroupLinkSystem.findOrCreateGroupByName(b.grade,b.groupName.trim());
      b.groupId=grp?grp.id:null;
    }

    const assignments=activeBlocks.map(b=>({grade:b.grade,groupId:b.groupId,pricePerSession:parseFloat(b.price)||0}));

    const teacherId=editId||Date.now();
    if(editId){
      const idx=_teachers.findIndex(x=>x.id===editId);
      if(idx!==-1) _teachers[idx]={..._teachers[idx],name,subject,assignments};
    } else {
      _teachers.push({id:teacherId,name,subject,assignments,createdAt:new Date().toISOString()});
    }
    await StorageEngine.save('teachers', _teachers);

    await _syncLessonsForTeacher(teacherId, subject, activeBlocks);

    window._closeModal('teacher-form-modal');
    renderTeachersGrid();
    if(_activeTeacherId===teacherId){ const tt=_teachers.find(x=>x.id===teacherId); if(tt) renderTeacherAccount(tt); }
    notify(editId?'✅ تم تعديل بيانات المدرس وجدوله':'✅ تم إضافة المدرس وجدوله بنجاح','success');
  }

  async function _syncLessonsForTeacher(teacherId, subject, activeBlocks){
    let existing=[];
    try{ existing=(await StorageEngine.getAll('lessons')||[]).filter(l=>String(l.teacherId)===String(teacherId)); }
    catch(e){ existing=[]; }

    const existingByKey=new Map();
    existing.forEach(l=>existingByKey.set(`${l.grade}||${l.groupId||''}||${l.day}`, l));

    const toSave=[];
    const keepKeys=new Set();
    let counter=0;
    const baseId=Date.now();

    activeBlocks.forEach(b=>{
      b.slots.forEach(s=>{
        const key=`${b.grade}||${b.groupId||''}||${s.day}`;
        keepKeys.add(key);
        const old=existingByKey.get(key);
        if(old){
          toSave.push({...old, teacherId, subject, grade:b.grade, groupId:b.groupId, day:s.day, timeFrom:s.from, timeTo:s.to});
        } else {
          toSave.push({
            id: baseId+(counter++), hallId:null, teacherId, subject,
            grade:b.grade, groupId:b.groupId, day:s.day, timeFrom:s.from, timeTo:s.to,
            notes:'', createdAt:new Date().toISOString()
          });
        }
      });
    });

    const toDeleteIds=existing.filter(l=>!keepKeys.has(`${l.grade}||${l.groupId||''}||${l.day}`)).map(l=>l.id);

    if(toSave.length>0) await StorageEngine.save('lessons', toSave);
    for(const id of toDeleteIds) await StorageEngine.delete('lessons', id);

    if(window.HallsModule && typeof HallsModule.reload==='function'){
      try{ await HallsModule.reload(); }catch(e){}
    }
  }

  async function deleteTeacher(id){
    if(!confirm('هل أنت متأكد من حذف هذا المدرس وكل بياناته؟')) return;
    _teachers=_teachers.filter(t=>t.id!==id);
    await StorageEngine.delete('teachers',id);
    const logIds=_logs.filter(l=>l.teacherId===id).map(l=>l.id);
    for(const k of logIds) await _delFrom('teacherLogs',k);
    _logs=_logs.filter(l=>l.teacherId!==id);
    try{
      const allLessons=await StorageEngine.getAll('lessons')||[];
      const idsToDelete=allLessons.filter(l=>String(l.teacherId)===String(id)).map(l=>l.id);
      for(const lid of idsToDelete) await StorageEngine.delete('lessons', lid);
      if(window.HallsModule && typeof HallsModule.reload==='function') await HallsModule.reload();
    }catch(e){ console.warn('[teachers] تعذر تنظيف حصص المدرس المحذوف',e); }
    renderTeachersGrid();
    notify('✅ تم حذف المدرس وجدوله بالكامل','success');
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

  // ── الحصول على اسم الشهر بالعربية ──
  function _monthNameAr(yearMonth){
    const months=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const [y,m]=yearMonth.split('-');
    return `${months[parseInt(m,10)-1]} ${y}`;
  }

  // ── الشهر الحالي yyyy-mm ──
  function _currentYearMonth(){
    const d=new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
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

    const tLessons=_teacherLessons(t.id);
    const teacherMonthlyDues=_monthlyDues.filter(d=>d.teacherId===t.id).sort((a,b)=>b.yearMonth.localeCompare(a.yearMonth));

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
        <button onclick="TeachersModule.showNewMonthModal(${t.id})"
          style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:white;border:none;border-radius:10px;padding:0.5rem 1.2rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-calendar-plus"></i> بداية شهر جديد
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
            style="border-radius:8px;border:1px solid var(--border);padding:4px 8px;font-size:0.8rem;">`:''
        }
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

      <!-- جدول الحضور والغياب الشهري -->
      ${_renderAttendanceTable(t)}

      <!-- Detailed Session Statement -->
      ${_renderSessionStatement(t, attendedLogs)}

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

      <!-- المستحقات الشهرية -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-alt" style="margin-left:6px;"></i> المستحقات الشهرية المحفوظة
        </h3>
        ${teacherMonthlyDues.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;">لم يتم ترحيل أي شهر بعد. عند الضغط على "بداية شهر جديد" سيتم حفظ مستحقات الشهر الحالي هنا.</p>`
          :`<div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:0.82rem;">
                <thead><tr style="background:var(--bg-light);">
                  <th style="padding:8px 10px;text-align:right;">الشهر</th>
                  <th style="padding:8px 10px;text-align:center;">عدد الحصص</th>
                  <th style="padding:8px 10px;text-align:center;">المستحقات (ج)</th>
                  <th style="padding:8px 10px;text-align:center;">تاريخ الترحيل</th>
                  <th style="padding:8px 10px;text-align:center;">ملاحظات</th>
                </tr></thead>
                <tbody>
                  ${teacherMonthlyDues.map(d=>`
                    <tr style="border-bottom:1px solid var(--bg-light);">
                      <td style="padding:8px 10px;font-weight:700;">${_esc(_monthNameAr(d.yearMonth))}</td>
                      <td style="padding:8px 10px;text-align:center;">${d.sessionCount||0}</td>
                      <td style="padding:8px 10px;text-align:center;font-weight:800;color:#4f46e5;">${(d.amount||0).toLocaleString('ar-EG')}</td>
                      <td style="padding:8px 10px;text-align:center;color:var(--text-muted);">${new Date(d.archivedAt||d.id).toLocaleDateString('ar-EG')}</td>
                      <td style="padding:8px 10px;color:var(--text-muted);">${_esc(d.notes||'—')}</td>
                    </tr>`).join('')}
                  <tr style="background:var(--bg-light);font-weight:800;">
                    <td style="padding:8px 10px;">الإجمالي</td>
                    <td style="padding:8px 10px;text-align:center;">${teacherMonthlyDues.reduce((s,d)=>s+(d.sessionCount||0),0)}</td>
                    <td style="padding:8px 10px;text-align:center;color:#4f46e5;">${teacherMonthlyDues.reduce((s,d)=>s+(d.amount||0),0).toLocaleString('ar-EG')}</td>
                    <td colspan="2"></td>
                  </tr>
                </tbody>
              </table>
            </div>`
        }
      </div>

      <!-- Weekly Schedule -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-week" style="margin-left:6px;"></i> الجدول الأسبوعي
        </h3>
        ${tLessons.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;">لم يتم إضافة حصص في نظام القاعات بعد.</p>`
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

  // ══════════════════════════════════════════════════════════
  //  جدول الحضور والغياب الشهري — القلب الجديد للنظام
  // ══════════════════════════════════════════════════════════
  function _renderAttendanceTable(t){
    const tLessons = _teacherLessons(t.id);
    if(tLessons.length===0){
      return `
        <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
          <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
            <i class="fas fa-table" style="margin-left:6px;"></i> جدول الحضور والغياب الشهري
          </h3>
          <p style="color:var(--text-muted);font-size:0.85rem;">لم يتم إضافة مجموعات للمدرس بعد.</p>
        </div>`;
    }

    const currentYM = _currentYearMonth();
    const teacherLogs = _logs.filter(l=>l.teacherId===t.id && (l.date||'').substring(0,7)===currentYM);

    // بناء صفوف الجدول — كل سجل حضور منفصل
    // + صفوف فارغة لكل مجموعة لإضافة حصص جديدة
    const groups = (t.assignments||[]);

    return `
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem;">
          <h3 style="margin:0;font-size:0.95rem;font-weight:800;color:var(--primary);">
            <i class="fas fa-table" style="margin-left:6px;"></i> جدول الحضور والغياب — ${_monthNameAr(currentYM)}
          </h3>
          <span style="background:#eff6ff;color:#4f46e5;border-radius:20px;padding:3px 12px;font-size:0.78rem;font-weight:700;">
            ${teacherLogs.filter(l=>l.status==='attended').length} حصة منجزة هذا الشهر
          </span>
        </div>

        <!-- إضافة حصة جديدة -->
        <div style="background:#f0fdf4;border:1.5px dashed #86efac;border-radius:12px;padding:1rem;margin-bottom:1.2rem;">
          <div style="font-weight:800;font-size:0.88rem;color:#16a34a;margin-bottom:0.75rem;">
            <i class="fas fa-plus-circle" style="margin-left:5px;"></i> تسجيل حضور حصة جديدة
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:0.6rem;align-items:end;flex-wrap:wrap;">
            <div>
              <label style="font-size:0.78rem;font-weight:700;color:var(--text-muted);display:block;margin-bottom:3px;">المجموعة</label>
              <select id="att-group-${t.id}" class="form-input" style="font-size:0.85rem;padding:0.5rem 0.7rem;">
                <option value="">— اختر المجموعة —</option>
                ${groups.map(a=>`<option value="${_esc(JSON.stringify({grade:a.grade,groupId:a.groupId||'',price:a.pricePerSession||0}))}">${_esc(gLabel(a.grade))} — ${_esc(grpName(a.groupId))} (${(a.pricePerSession||0).toLocaleString('ar-EG')} ج)</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="font-size:0.78rem;font-weight:700;color:var(--text-muted);display:block;margin-bottom:3px;">تاريخ الحصة (أنت تحدده)</label>
              <input type="date" id="att-date-${t.id}" class="form-input" value="${new Date().toISOString().split('T')[0]}" style="font-size:0.85rem;padding:0.5rem 0.7rem;">
            </div>
            <div style="display:flex;gap:0.5rem;">
              <button onclick="TeachersModule.registerAttendance(${t.id},'attended')"
                style="background:#16a34a;color:white;border:none;border-radius:10px;padding:0.5rem 1rem;cursor:pointer;font-weight:700;font-size:0.85rem;white-space:nowrap;">
                <i class="fas fa-check"></i> حاضر
              </button>
              <button onclick="TeachersModule.registerAttendance(${t.id},'absent')"
                style="background:#ef4444;color:white;border:none;border-radius:10px;padding:0.5rem 1rem;cursor:pointer;font-weight:700;font-size:0.85rem;white-space:nowrap;">
                <i class="fas fa-times"></i> غائب
              </button>
            </div>
          </div>
        </div>

        <!-- الجدول التفصيلي -->
        ${teacherLogs.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem;">لم يتم تسجيل أي حصص هذا الشهر بعد.</p>`
          :`<div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:0.82rem;min-width:550px;">
                <thead>
                  <tr style="background:var(--bg-light);">
                    <th style="padding:8px 10px;text-align:right;">#</th>
                    <th style="padding:8px 10px;text-align:right;">التاريخ</th>
                    <th style="padding:8px 10px;text-align:center;">المجموعة</th>
                    <th style="padding:8px 10px;text-align:center;">الصف</th>
                    <th style="padding:8px 10px;text-align:center;">الحالة</th>
                    <th style="padding:8px 10px;text-align:center;">قيمة الحصة</th>
                    <th style="padding:8px 10px;text-align:center;">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  ${teacherLogs.sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map((l,i)=>{
                    const price = _getPriceForLog(t,l);
                    const statusCfg={
                      attended:{bg:'#dcfce7',color:'#16a34a',label:'حاضر'},
                      absent:{bg:'#fef2f2',color:'#ef4444',label:'غائب'},
                      postponed:{bg:'#fefce8',color:'#a16207',label:'مؤجّل'},
                      cancelled:{bg:'#f1f5f9',color:'#64748b',label:'ملغي'},
                    }[l.status]||{bg:'#f1f5f9',color:'#64748b',label:l.status};
                    return `
                      <tr style="border-bottom:1px solid var(--bg-light);">
                        <td style="padding:7px 10px;color:var(--text-muted);">${i+1}</td>
                        <td style="padding:7px 10px;font-weight:700;">${new Date(l.date).toLocaleDateString('ar-EG')}</td>
                        <td style="padding:7px 10px;text-align:center;">${_esc(grpName(l.groupId))}</td>
                        <td style="padding:7px 10px;text-align:center;">${_esc(gLabel(l.grade))}</td>
                        <td style="padding:7px 10px;text-align:center;">
                          <span style="background:${statusCfg.bg};color:${statusCfg.color};border-radius:20px;padding:3px 10px;font-size:0.75rem;font-weight:700;">${statusCfg.label}</span>
                        </td>
                        <td style="padding:7px 10px;text-align:center;font-weight:700;color:${l.status==='attended'?'#4f46e5':'#9ca3af'};">
                          ${l.status==='attended'?price.toLocaleString('ar-EG')+' ج':'—'}
                        </td>
                        <td style="padding:7px 10px;text-align:center;">
                          <button onclick="TeachersModule.deleteAttendanceLog(${t.id},'${l.id}')"
                            style="background:#fef2f2;border:none;border-radius:6px;padding:3px 8px;cursor:pointer;color:#ef4444;font-size:0.75rem;">
                            <i class="fas fa-trash"></i>
                          </button>
                        </td>
                      </tr>`;
                  }).join('')}
                </tbody>
                <tfoot>
                  <tr style="background:var(--bg-light);font-weight:800;">
                    <td colspan="5" style="padding:9px 10px;">
                      الإجمالي: ${teacherLogs.filter(l=>l.status==='attended').length} حصة حضور
                    </td>
                    <td style="padding:9px 10px;text-align:center;color:#4f46e5;">
                      ${_calcMonthDue(t.id, currentYM).toLocaleString('ar-EG')} ج
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>`
        }
      </div>`;
  }

  // ── تسجيل حضور/غياب حصة جديدة بتاريخ مخصص ──
  async function registerAttendance(teacherId, status){
    const t = _teachers.find(x=>x.id===teacherId);
    if(!t) return;

    const groupSel = document.getElementById(`att-group-${teacherId}`);
    const dateSel  = document.getElementById(`att-date-${teacherId}`);

    if(!groupSel?.value) return notify('يرجى اختيار المجموعة أولاً','error');
    if(!dateSel?.value)  return notify('يرجى تحديد تاريخ الحصة','error');

    let groupData;
    try { groupData = JSON.parse(groupSel.value); } catch(e){ return notify('خطأ في بيانات المجموعة','error'); }

    const { grade, groupId, price } = groupData;
    const dateVal = dateSel.value; // YYYY-MM-DD

    // منع التكرار: نفس المجموعة في نفس التاريخ
    const duplicate = _logs.find(l=>
      l.teacherId === teacherId &&
      String(l.grade) === String(grade) &&
      String(l.groupId||'') === String(groupId||'') &&
      (l.date||'').substring(0,10) === dateVal
    );

    if(duplicate){
      if(!confirm(`يوجد تسجيل سابق لهذه المجموعة بتاريخ ${dateVal}. هل تريد استبداله؟`)) return;
      _logs = _logs.filter(l=>l.id!==duplicate.id);
      try{ await _delFrom('teacherLogs', duplicate.id); }catch(e){}
    }

    const logId = Date.now();
    const newLog = {
      id: logId,
      teacherId,
      grade,
      groupId: groupId||null,
      status,
      date: dateVal + 'T00:00:00.000Z',
      priceSnapshot: parseFloat(price)||0,
      createdAt: new Date().toISOString()
    };

    _logs.push(newLog);
    try{
      await _ensureStores();
      await StorageEngine.save('teacherLogs', newLog);
    }catch(e){ console.warn('[teachers] save log failed',e); }

    const statusLabel = status==='attended' ? '✅ تم تسجيل الحضور' : '❌ تم تسجيل الغياب';
    notify(statusLabel + ` — ${gLabel(grade)} (${grpName(groupId)}) — ${dateVal}`, 'success');

    renderTeacherAccount(t);
  }

  // ── حذف سجل حضور ──
  async function deleteAttendanceLog(teacherId, logId){
    if(!confirm('هل تريد حذف هذا التسجيل؟')) return;
    _logs = _logs.filter(l=>String(l.id)!==String(logId));
    try{ await _delFrom('teacherLogs', parseInt(logId)||logId); }catch(e){}
    notify('تم حذف التسجيل','success');
    const t=_teachers.find(x=>x.id===teacherId);
    if(t) renderTeacherAccount(t);
  }

  // ── كشف الحصص التفصيلي ──
  function _renderSessionStatement(t, attendedLogs){
    const totalDue = _calcDue(t.id, attendedLogs);
    return `
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-file-invoice" style="margin-left:6px;"></i> كشف الحصص التفصيلي (الفترة المختارة)
        </h3>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:0.82rem;min-width:600px;">
            <thead>
              <tr style="background:var(--bg-light);">
                <th style="padding:8px 10px;text-align:right;border-radius:8px 0 0 8px;">التاريخ</th>
                <th style="padding:8px 10px;text-align:center;">المجموعة</th>
                <th style="padding:8px 10px;text-align:center;">الصف</th>
                <th style="padding:8px 10px;text-align:center;">سعر الحصة</th>
                <th style="padding:8px 10px;text-align:left;border-radius:0 8px 8px 0;">القيمة</th>
              </tr>
            </thead>
            <tbody>
              ${attendedLogs.sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map(l=>{
                const price = _getPriceForLog(t, l);
                return `
                  <tr style="border-bottom:1px solid var(--bg-light);">
                    <td style="padding:7px 10px;">${new Date(l.date).toLocaleDateString('ar-EG')}</td>
                    <td style="padding:7px 10px;text-align:center;">${_esc(grpName(l.groupId))}</td>
                    <td style="padding:7px 10px;text-align:center;">${_esc(gLabel(l.grade))}</td>
                    <td style="padding:7px 10px;text-align:center;">${price.toLocaleString('ar-EG')} ج</td>
                    <td style="padding:7px 10px;text-align:left;font-weight:700;color:var(--primary);">${price.toLocaleString('ar-EG')} ج</td>
                  </tr>`;
              }).join('')}
              ${attendedLogs.length===0?`
                <tr><td colspan="5" style="padding:1.5rem;text-align:center;color:var(--text-muted);">لا توجد حصص مسجّلة في هذه الفترة</td></tr>`:''
              }
            </tbody>
            <tfoot>
              <tr style="background:var(--bg-light);font-weight:800;">
                <td colspan="3" style="padding:9px 10px;border-radius:8px 0 0 8px;">الإجمالي (${attendedLogs.length} حصة)</td>
                <td style="padding:9px 10px;text-align:center;">---</td>
                <td style="padding:9px 10px;text-align:left;color:var(--primary);font-size:0.95rem;border-radius:0 8px 8px 0;">${totalDue.toLocaleString('ar-EG')} ج</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════
  //  بداية شهر جديد — ترحيل وحفظ المستحقات
  // ══════════════════════════════════════════════════════════
  function showNewMonthModal(teacherId){
    const t=_teachers.find(x=>x.id===teacherId);
    if(!t) return;

    const currentYM = _currentYearMonth();
    const currentMonthLogs = _logs.filter(l=>l.teacherId===teacherId && l.status==='attended' && (l.date||'').substring(0,7)===currentYM);
    const currentMonthDue = _calcMonthDue(teacherId, currentYM);
    const monthLabel = _monthNameAr(currentYM);

    // الشهر القادم
    const [y,m] = currentYM.split('-').map(Number);
    const nextM = m===12 ? 1 : m+1;
    const nextY = m===12 ? y+1 : y;
    const nextYM = `${nextY}-${String(nextM).padStart(2,'0')}`;

    const modal=_mkModal('new-month-modal',`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;">
        <h2 style="margin:0;color:#7c3aed;font-size:1.1rem;font-weight:800;">
          <i class="fas fa-calendar-plus" style="margin-left:8px;"></i> بداية شهر جديد — ${_esc(t.name)}
        </h2>
        <button onclick="window._closeModal('new-month-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>

      <div style="background:#faf5ff;border:1.5px solid #d8b4fe;border-radius:12px;padding:1rem;margin-bottom:1.2rem;">
        <div style="font-weight:800;font-size:0.9rem;color:#7c3aed;margin-bottom:0.75rem;">
          <i class="fas fa-archive" style="margin-left:5px;"></i> سيتم ترحيل وحفظ بيانات شهر ${_esc(monthLabel)}:
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.6rem;">
          <div style="background:white;border-radius:10px;padding:0.75rem;text-align:center;">
            <div style="font-size:1.3rem;font-weight:800;color:#4f46e5;">${currentMonthLogs.length}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);">عدد الحصص المنجزة</div>
          </div>
          <div style="background:white;border-radius:10px;padding:0.75rem;text-align:center;">
            <div style="font-size:1.3rem;font-weight:800;color:#16a34a;">${currentMonthDue.toLocaleString('ar-EG')} ج</div>
            <div style="font-size:0.72rem;color:var(--text-muted);">إجمالي مستحقات الشهر</div>
          </div>
        </div>
      </div>

      <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:12px;padding:0.85rem;margin-bottom:1.2rem;font-size:0.85rem;color:#9a3412;">
        <i class="fas fa-info-circle" style="margin-left:5px;"></i>
        <strong>ملاحظة:</strong> لن يتم حذف أي بيانات. سيتم حفظ مستحقات ${_esc(monthLabel)} في قسم "المستحقات الشهرية" وإنشاء جدول نظيف لشهر ${_esc(_monthNameAr(nextYM))}.
      </div>

      <div style="margin-bottom:1.2rem;">
        <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">ملاحظات (اختياري)</label>
        <input id="nm-notes" type="text" class="form-input" placeholder="مثال: تم التسوية في نهاية الشهر">
      </div>

      <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
        <button onclick="window._closeModal('new-month-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._confirmNewMonth(${teacherId},'${currentYM}')"
          style="background:linear-gradient(135deg,#7c3aed,#4f46e5);color:white;border:none;border-radius:10px;padding:0.6rem 2rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-check"></i> تأكيد البدء بشهر جديد
        </button>
      </div>
    `);
    document.body.appendChild(modal);
  }

  async function _confirmNewMonth(teacherId, yearMonth){
    const t=_teachers.find(x=>x.id===teacherId);
    if(!t) return;

    const notes = document.getElementById('nm-notes')?.value.trim();
    const currentMonthLogs = _logs.filter(l=>l.teacherId===teacherId && l.status==='attended' && (l.date||'').substring(0,7)===yearMonth);
    const monthDue = _calcMonthDue(teacherId, yearMonth);

    // حفظ المستحقات الشهرية
    const dueRecord = {
      id: Date.now(),
      teacherId,
      yearMonth,
      amount: monthDue,
      sessionCount: currentMonthLogs.length,
      notes: notes||'',
      archivedAt: new Date().toISOString()
    };

    _monthlyDues.push(dueRecord);
    try{
      await _ensureStores();
      await StorageEngine.save('teacherMonthlyDues', dueRecord);
    }catch(e){ console.warn('[teachers] save monthlyDue failed',e); }

    window._closeModal('new-month-modal');
    notify(`✅ تم ترحيل مستحقات ${_monthNameAr(yearMonth)} (${monthDue.toLocaleString('ar-EG')} ج) وحفظها بنجاح`,'success');

    renderTeacherAccount(t);
  }

  // ══════════════════════════════════════════════════════════
  //  Log Session (legacy — للتوافق مع teachers-attendance.js)
  // ══════════════════════════════════════════════════════════
  async function logSession(teacherId, lessonId, status, grade, groupId, hallId=''){
    const today=new Date().toISOString().split('T')[0];
    const old=_logs.find(l=>l.teacherId===teacherId&&l.lessonId===lessonId&&l.date?.startsWith(today));
    if(old){ _logs=_logs.filter(l=>l.id!==old.id); await _delFrom('teacherLogs',old.id); }

    const t=_teachers.find(x=>x.id===teacherId);
    const price = t ? _getPriceForLog(t, {grade, groupId}) : 0;

    const log={id:Date.now(),teacherId,lessonId,status,grade,groupId:groupId||null,hallId:hallId||null,date:new Date().toISOString(),priceSnapshot:price};
    _logs.push(log);
    await StorageEngine.save('teacherLogs', log);
    notify({attended:'✓ تم تسجيل الحضور',absent:'✕ تم تسجيل الغياب',postponed:'⏸ تم تسجيل التأجيل',cancelled:'تم إلغاء الحصة'}[status]||'تم التسجيل','success');
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

  function _buildGradeOpts(sel=''){
    return window.GradeGroupLinkSystem.buildGradeOptions(sel);
  }

  // ── Table helpers ──
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

  // ── Helpers ──
  function toMin(t){ const[h,m]=(t||'00:00').split(':').map(Number); return h*60+(m||0); }

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

  function _mkModalWide(id,content){
    const ex=document.getElementById(id); if(ex) ex.remove();
    const m=document.createElement('div');
    m.id=id;
    m.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);overflow-y:auto;';
    m.innerHTML=`<div style="background:var(--bg-white,#fff);border-radius:20px;padding:2rem;max-width:920px;width:96%;max-height:92vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,0.3);direction:rtl;font-family:inherit;margin:auto;">${content}</div>`;
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
    registerAttendance,
    deleteAttendanceLog,
    showNewMonthModal,
    _confirmNewMonth,
    showPayoutModal,
    showAdvanceModal,
    deletePayout,
    deleteAdvance,
    setFilter,
    setCustomRange,
    _toggleGrade,
    _addGroupBlock,
    _removeGroupBlock,
    _updateBlockField,
    _toggleDay,
    _updateSlotTime,
    _saveTeacher,
    _confirmPayout,
    _confirmAdvance,
  };

  console.log('[teachers.js] v4.0 ✅ نظام حسابات المدرسين + جدول حضور شهري + مستحقات شهرية جاهز');
})();
