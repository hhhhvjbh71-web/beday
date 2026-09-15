// ============================================================
//  halls.js  —  نظام إدارة القاعات + الجدول المركزي للحصص
//  v2.0 — مُدمَج مع حسابات المدرسين وكشف التعارض الكامل
// ============================================================

(function () {
  'use strict';

  const ARABIC_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const DAY_KEYS    = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const HALL_COLORS = [
    '#4f46e5','#0ea5e9','#10b981','#f59e0b',
    '#ef4444','#8b5cf6','#ec4899','#14b8a6'
  ];

  // ── State ──
  let halls    = [];
  let lessons  = [];   // الجدول المركزي (بديل hallBookings)
  let teachers = [];
  let activeHallId = null;
  let editingHallId = null;
  let editingLessonId = null;

  // ── DB helpers ──
  async function _ensureStores() {
    if (!window.StorageEngine) return;
    if (!StorageEngine.db) await StorageEngine.init();
    // Ensure lessons store exists (v10)
    const needed = ['halls','lessons','teachers'];
    const missing = needed.filter(n => StorageEngine.db && !StorageEngine.db.objectStoreNames.contains(n));
    if (missing.length > 0) {
      console.warn('[Halls] missing stores:', missing);
    }
  }

  async function loadData() {
    await _ensureStores();
    try { halls    = await StorageEngine.getAll('halls')   || []; } catch(e){ halls=[]; }
    try { lessons  = await StorageEngine.getAll('lessons') || []; } catch(e){ lessons=[]; }
    try { teachers = await StorageEngine.getAll('teachers')|| []; } catch(e){ teachers=[]; }
  }

  async function _save(store, obj) {
    await _ensureStores();
    await StorageEngine.save(store, obj);
  }
  async function _del(store, id) {
    await _ensureStores();
    await StorageEngine.delete(store, id);
  }

  // ── Helpers ──
  function toMin(t) {
    const [h,m] = (t||'00:00').split(':').map(Number);
    return h*60+(m||0);
  }

  // تحويل الوقت من نظام 24 ساعة إلى 12 ساعة مع صباحًا/مساءً
  function fmt12(t){
    if(!t) return '--:--';
    const [h,m]=(t||'00:00').split(':').map(Number);
    const period=h<12?'ص':'م';
    const h12=h%12||12;
    const mm=String(m||0).padStart(2,'0');
    return `${h12}:${mm} ${period}`;
  }
  function _esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function notify(msg, type='success') {
    if(typeof showNotification==='function') showNotification(msg, type);
    else alert(msg);
  }
  function hallColor(h){ return h.color||HALL_COLORS[0]; }

  function gradeName(gradeId){
    const g=(window.gradesList||[]).find(x=>String(x.id)===String(gradeId)||String(x.systemCode)===String(gradeId));
    return g?g.name:(gradeId||'---');
  }
  function groupName(gid){
    if(!gid) return 'عام';
    const g=(window.db&&db.groups||[]).find(x=>String(x.id)===String(gid));
    return g?g.name:'مجموعة';
  }
  function teacherName(tid){
    const t=teachers.find(x=>String(x.id)===String(tid));
    return t?t.name:'---';
  }
  function groupStudentCount(gid){
    if(!gid||!window.db) return 0;
    return (db.students||[]).filter(s=>String(s.groupId)===String(gid)).length +
           (db.enrollments||[]).filter(e=>String(e.groupId)===String(gid)).length;
  }

  // ── Conflict detection ──
  function detectHallConflict(hallId, day, from, to, excludeId=null){
    const newF=toMin(from), newT=toMin(to);
    const same=lessons.filter(l=>
      String(l.hallId)===String(hallId) && l.day===day &&
      String(l.id)!==String(excludeId)
    );
    for(const l of same){
      if(newF<toMin(l.timeTo) && newT>toMin(l.timeFrom)){
        return {conflict:true, with:l};
      }
    }
    return {conflict:false, with:null};
  }

  function detectTeacherConflict(teacherId, day, from, to, excludeId=null){
    if(!teacherId) return {conflict:false,with:null};
    const newF=toMin(from), newT=toMin(to);
    const same=lessons.filter(l=>
      String(l.teacherId)===String(teacherId) && l.day===day &&
      String(l.id)!==String(excludeId)
    );
    for(const l of same){
      if(newF<toMin(l.timeTo) && newT>toMin(l.timeFrom)){
        return {conflict:true, with:l};
      }
    }
    return {conflict:false, with:null};
  }

  function checkCapacity(hallId, groupId){
    const hall=halls.find(h=>String(h.id)===String(hallId));
    if(!hall||!hall.capacity||!groupId) return {over:false};
    const cap=parseInt(hall.capacity)||0;
    const count=groupStudentCount(groupId);
    return {over:count>cap, count, cap};
  }

  // ── Build options ──
  // ⚠️ اختيار المجموعة بالـ dropdown اتلغى بالكامل من مودال "إضافة حصة" —
  // بقى حقل كتابة حرة (ls-group) بيرجع بـ GradeGroupLinkSystem.findOrCreateGroupByName
  // وقت الحفظ. buildGradeOptions لسه مستخدمة لقائمة "الصف" بس.
  function buildGradeOptions(sel=''){
    return window.GradeGroupLinkSystem.buildGradeOptions(sel);
  }
  function buildTeacherOptions(selT=''){
    return `<option value="">-- اختر المدرس --</option>` +
      teachers.map(t=>`<option value="${t.id}" ${String(t.id)===String(selT)?'selected':''}>${_esc(t.name)}</option>`).join('');
  }
  function buildHallOptions(selH=''){
    return `<option value="">-- اختر القاعة --</option>` +
      halls.map(h=>`<option value="${h.id}" ${String(h.id)===String(selH)?'selected':''}>${_esc(h.name)}</option>`).join('');
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER MAIN HALLS SECTION
  // ══════════════════════════════════════════════════════════
  function renderHallsSection(){
    const container=document.getElementById('halls-content');
    if(!container) return;

    const todayKey=DAY_KEYS[new Date().getDay()];
    const todayLessons=lessons.filter(l=>l.day===todayKey);
    const busyHalls=new Set(todayLessons.map(l=>String(l.hallId)));

    // Stats bar
    const totalLessons=lessons.length;
    const totalTeachers=teachers.length;

    let html = `
      <!-- ── Dashboard ── -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-bottom:1.5rem;">
        ${[
          {icon:'fa-building',label:'إجمالي القاعات',val:halls.length,color:'#8b5cf6'},
          {icon:'fa-door-open',label:'مشغولة اليوم',val:busyHalls.size,color:'#ef4444'},
          {icon:'fa-check-circle',label:'متاحة اليوم',val:halls.length-busyHalls.size,color:'#10b981'},
          {icon:'fa-calendar-alt',label:'إجمالي الحصص',val:totalLessons,color:'#0ea5e9'},
          {icon:'fa-chalkboard-teacher',label:'المدرسون',val:totalTeachers,color:'#f59e0b'},
        ].map(s=>`
          <div style="background:var(--bg-white);border-radius:14px;padding:1rem;text-align:center;box-shadow:0 1px 8px rgba(0,0,0,0.06);">
            <i class="fas ${s.icon}" style="color:${s.color};font-size:1.3rem;display:block;margin-bottom:6px;"></i>
            <div style="font-size:1.3rem;font-weight:800;color:${s.color};">${s.val}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);">${s.label}</div>
          </div>`).join('')}
      </div>

      <!-- ── Tabs ── -->
      <div style="display:flex;gap:0.5rem;margin-bottom:1.2rem;flex-wrap:wrap;">
        <button onclick="HallsModule.showTab('halls')" id="tab-halls"
          class="halls-tab" style="padding:0.55rem 1.2rem;border-radius:10px;border:1.5px solid var(--border);cursor:pointer;font-weight:700;font-size:0.88rem;background:var(--primary);color:white;">
          <i class="fas fa-building"></i> القاعات
        </button>
        <button onclick="HallsModule.showTab('schedule')" id="tab-schedule"
          class="halls-tab" style="padding:0.55rem 1.2rem;border-radius:10px;border:1.5px solid var(--border);cursor:pointer;font-weight:700;font-size:0.88rem;background:var(--bg-white);color:var(--text-main);">
          <i class="fas fa-calendar-week"></i> الجدول المركزي
        </button>
        <button onclick="HallsModule.showTab('dashboard')" id="tab-dashboard"
          class="halls-tab" style="padding:0.55rem 1.2rem;border-radius:10px;border:1.5px solid var(--border);cursor:pointer;font-weight:700;font-size:0.88rem;background:var(--bg-white);color:var(--text-main);">
          <i class="fas fa-chart-bar"></i> لوحة المتابعة
        </button>
      </div>

      <!-- ── Tab Content ── -->
      <div id="halls-tab-content"></div>`;

    container.innerHTML = html;
    showTab('halls');
  }

  function showTab(tab){
    // Update tab buttons style
    document.querySelectorAll('.halls-tab').forEach(btn=>{
      btn.style.background='var(--bg-white)';
      btn.style.color='var(--text-main)';
      btn.style.borderColor='var(--border)';
    });
    const activeBtn=document.getElementById(`tab-${tab}`);
    if(activeBtn){ activeBtn.style.background='var(--primary)'; activeBtn.style.color='white'; }

    const tc=document.getElementById('halls-tab-content');
    if(!tc) return;

    if(tab==='halls')      tc.innerHTML=renderHallsGrid();
    else if(tab==='schedule') tc.innerHTML=renderCentralSchedule();
    else if(tab==='dashboard') tc.innerHTML=renderDashboard();
  }

  // ══════════════════════════════════════════════════════════
  //  HALLS GRID TAB
  // ══════════════════════════════════════════════════════════
  function renderHallsGrid(){
    const todayKey=DAY_KEYS[new Date().getDay()];

    if(halls.length===0){
      return `<div style="text-align:center;padding:4rem 2rem;color:var(--text-muted);">
        <div style="font-size:3.5rem;margin-bottom:1rem;opacity:0.2;">🏫</div>
        <p style="font-size:1.1rem;font-weight:700;margin-bottom:1.5rem;">لا توجد قاعات مضافة بعد</p>
        <button onclick="HallsModule.openAddHallModal()"
          style="padding:0.75rem 2rem;background:var(--primary);color:white;border:none;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;">
          <i class="fas fa-plus"></i> إضافة قاعة
        </button>
      </div>`;
    }

    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:1.1rem;">
        ${halls.map(h=>_hallCard(h, todayKey)).join('')}
        <div onclick="HallsModule.openAddHallModal()"
          style="border:2px dashed var(--border);border-radius:18px;padding:2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5rem;cursor:pointer;min-height:160px;color:var(--text-muted);transition:all 0.2s;"
          onmouseover="this.style.borderColor='var(--primary)';this.style.color='var(--primary)'"
          onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          <i class="fas fa-plus-circle" style="font-size:2rem;"></i>
          <span style="font-weight:700;">إضافة قاعة جديدة</span>
        </div>
      </div>
      <div id="hall-detail-panel" style="margin-top:1rem;"></div>`;
  }

  function _hallCard(hall, todayKey){
    const color=hallColor(hall);
    const hallLessons=lessons.filter(l=>String(l.hallId)===String(hall.id));
    const todayCount=hallLessons.filter(l=>l.day===todayKey).length;
    const isBusy=todayCount>0;
    const cap=hall.capacity?`• سعة: ${hall.capacity} طالب`:'';

    return `
      <div onclick="HallsModule.openHallDetail('${hall.id}')"
        style="background:var(--bg-white);border-radius:18px;padding:1.4rem;box-shadow:0 2px 12px rgba(0,0,0,0.06);
               border:1.5px solid var(--border);cursor:pointer;transition:all 0.2s;position:relative;overflow:hidden;"
        onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,0.1)'"
        onmouseout="this.style.transform='';this.style.boxShadow='0 2px 12px rgba(0,0,0,0.06)'">
        <div style="position:absolute;top:0;right:0;left:0;height:4px;background:${color};border-radius:18px 18px 0 0;"></div>

        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:0.5rem;">
          <div>
            <div style="width:44px;height:44px;border-radius:12px;background:${color}20;display:flex;align-items:center;justify-content:center;margin-bottom:0.75rem;">
              <i class="fas fa-door-open" style="color:${color};font-size:1.2rem;"></i>
            </div>
            <div style="font-weight:800;font-size:1.05rem;color:var(--text-main);">${_esc(hall.name)}</div>
            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;">${hallLessons.length} حصة إجمالاً ${cap}</div>
          </div>
          <div>
            <span style="padding:4px 10px;border-radius:20px;font-size:0.72rem;font-weight:700;
              background:${isBusy?'#fef2f2':'#f0fdf4'};color:${isBusy?'#ef4444':'#16a34a'};">
              ${isBusy?'مشغولة اليوم':'متاحة اليوم'}
            </span>
          </div>
        </div>

        <div style="display:flex;gap:4px;margin-top:0.9rem;flex-wrap:wrap;">
          ${DAY_KEYS.map((dk,i)=>{
            const has=hallLessons.some(l=>l.day===dk);
            return has?`<span style="background:${color}20;color:${color};border-radius:6px;padding:2px 8px;font-size:0.72rem;font-weight:700;">${ARABIC_DAYS[i]}</span>`:'';
          }).join('')}
        </div>

        <div style="display:flex;gap:5px;margin-top:0.8rem;" onclick="event.stopPropagation()">
          <button onclick="HallsModule.openEditHallModal('${hall.id}')"
            style="flex:1;padding:5px 0;border:none;background:var(--bg-light);border-radius:8px;cursor:pointer;color:var(--primary);font-size:0.78rem;">
            <i class="fas fa-edit"></i> تعديل
          </button>
          <button onclick="HallsModule.openAddLessonModal('${hall.id}')"
            style="flex:1;padding:5px 0;border:none;background:${color}15;border-radius:8px;cursor:pointer;color:${color};font-size:0.78rem;font-weight:700;">
            <i class="fas fa-plus"></i> حصة
          </button>
          <button onclick="HallsModule.deleteHall('${hall.id}')"
            style="padding:5px 10px;border:none;background:#fef2f2;border-radius:8px;cursor:pointer;color:#ef4444;font-size:0.78rem;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  // ── Hall Detail Panel ──
  function openHallDetail(hallId){
    activeHallId=hallId;
    const hall=halls.find(h=>String(h.id)===String(hallId));
    if(!hall) return;
    const color=hallColor(hall);
    const hallLessons=lessons.filter(l=>String(l.hallId)===String(hallId))
      .sort((a,b)=>DAY_KEYS.indexOf(a.day)-DAY_KEYS.indexOf(b.day)||toMin(a.timeFrom)-toMin(b.timeFrom));

    const byDay={};
    DAY_KEYS.forEach(dk=>{byDay[dk]=[];});
    hallLessons.forEach(l=>{if(byDay[l.day])byDay[l.day].push(l);});

    const cap=hall.capacity?`| السعة: ${hall.capacity}`:'';

    const panel=document.getElementById('hall-detail-panel');
    if(!panel) return;

    panel.style.cssText='background:var(--bg-white);border-radius:20px;box-shadow:0 4px 24px rgba(0,0,0,0.08);border:1.5px solid var(--border);overflow:hidden;';
    panel.innerHTML=`
      <div style="background:${color};padding:1.4rem 1.6rem;color:white;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
        <div>
          <div style="font-size:1.2rem;font-weight:800;"><i class="fas fa-door-open"></i> ${_esc(hall.name)}</div>
          <div style="font-size:0.82rem;opacity:0.85;margin-top:3px;">${hallLessons.length} حصة مجدولة ${cap}</div>
        </div>
        <div style="display:flex;gap:0.6rem;">
          <button onclick="HallsModule.openAddLessonModal('${hall.id}')"
            style="padding:0.5rem 1.1rem;background:white;color:${color};border:none;border-radius:10px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.85rem;">
            <i class="fas fa-plus"></i> حصة جديدة
          </button>
          <button onclick="document.getElementById('hall-detail-panel').style.display='none';HallsModule._activeHallId=null"
            style="padding:0.5rem 0.8rem;background:rgba(255,255,255,0.2);color:white;border:1px solid rgba(255,255,255,0.4);border-radius:10px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>

      <!-- Weekly Table -->
      <div style="padding:1.2rem;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;min-width:600px;">
          <thead>
            <tr style="background:var(--bg-light);">
              ${DAY_KEYS.map((dk,i)=>`
                <th style="padding:0.7rem 0.4rem;text-align:center;font-size:0.8rem;font-weight:800;
                  color:${dk===DAY_KEYS[new Date().getDay()]?color:'var(--text-main)'};
                  border-bottom:2px solid ${dk===DAY_KEYS[new Date().getDay()]?color:'var(--border)'};
                  min-width:110px;">
                  ${ARABIC_DAYS[i]}
                  ${dk===DAY_KEYS[new Date().getDay()]?'<br><span style="font-size:0.62rem;opacity:0.7;">اليوم</span>':''}
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr style="vertical-align:top;">
              ${DAY_KEYS.map(dk=>`
                <td style="padding:0.4rem;border-left:1px solid var(--border);">
                  ${byDay[dk].length===0
                    ?`<div style="min-height:50px;display:flex;align-items:center;justify-content:center;">
                        <button onclick="HallsModule.openAddLessonModal('${hall.id}','${dk}')"
                          style="color:var(--text-muted);border:1.5px dashed var(--border);background:none;border-radius:8px;padding:5px 8px;cursor:pointer;font-size:0.72rem;width:100%;">
                          <i class="fas fa-plus"></i>
                        </button>
                      </div>`
                    :byDay[dk].map(l=>_lessonMiniCard(l,color)).join('')+
                     `<button onclick="HallsModule.openAddLessonModal('${hall.id}','${dk}')"
                        style="width:100%;margin-top:4px;color:${color};border:1.5px dashed ${color}50;background:${color}08;border-radius:8px;padding:4px;cursor:pointer;font-size:0.7rem;font-weight:700;">
                        <i class="fas fa-plus"></i> فترة جديدة
                      </button>`}
                </td>`).join('')}
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Lessons List -->
      <div style="padding:0 1.2rem 1.2rem;">
        <div style="font-size:0.8rem;font-weight:800;color:var(--text-muted);margin-bottom:0.6rem;">كل الحصص (${hallLessons.length})</div>
        ${hallLessons.length===0
          ?`<div style="text-align:center;padding:1.5rem;color:var(--text-muted);font-size:0.88rem;">لا توجد حصص بعد</div>`
          :hallLessons.map(l=>_lessonRow(l,color)).join('')}
      </div>`;
  }

  function _lessonMiniCard(l, color){
    const tName=teacherName(l.teacherId);
    const grpName=groupName(l.groupId);
    return `
      <div style="background:${color}12;border:1.5px solid ${color}40;border-radius:11px;padding:0.55rem 0.65rem;margin-bottom:0.4rem;">
        <!-- وقت كبير وواضح بنظام 12 ساعة -->
        <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:3px;">
          <span style="font-size:1.05rem;font-weight:900;color:${color};line-height:1;">${fmt12(l.timeFrom)}</span>
          <span style="font-size:0.7rem;color:${color};opacity:0.7;">→</span>
          <span style="font-size:1.05rem;font-weight:900;color:${color};line-height:1;">${fmt12(l.timeTo)}</span>
        </div>
        <div style="font-size:0.72rem;color:var(--text-main);font-weight:700;margin-top:2px;">${_esc(tName)}</div>
        <div style="font-size:0.68rem;color:var(--text-muted);">${_esc(l.subject||gradeName(l.grade))} · ${_esc(grpName)}</div>
        <div style="display:flex;gap:3px;margin-top:5px;">
          <button onclick="HallsModule.openEditLessonModal('${l.id}')"
            style="flex:1;font-size:0.66rem;padding:2px 0;border:none;background:white;border-radius:5px;cursor:pointer;color:var(--primary);">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="HallsModule.deleteLesson('${l.id}')"
            style="flex:1;font-size:0.66rem;padding:2px 0;border:none;background:#fef2f2;border-radius:5px;cursor:pointer;color:#ef4444;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  function _lessonRow(l, color){
    const dayLabel=ARABIC_DAYS[DAY_KEYS.indexOf(l.day)]||l.day;
    const tName=teacherName(l.teacherId);
    const grpName=groupName(l.groupId);
    const gName=gradeName(l.grade);
    return `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.7rem 0.9rem;background:var(--bg-light);border-radius:12px;margin-bottom:0.45rem;flex-wrap:wrap;border-right:3px solid ${color};">
        <div style="display:flex;flex-direction:column;align-items:center;min-width:56px;">
          <span style="font-size:0.72rem;font-weight:800;color:${color};">${_esc(dayLabel)}</span>
        </div>
        <!-- وقت بارز بنظام 12 ساعة -->
        <div style="display:flex;align-items:baseline;gap:3px;min-width:140px;">
          <span style="font-size:1rem;font-weight:900;color:${color};">${fmt12(l.timeFrom)}</span>
          <span style="font-size:0.72rem;color:var(--text-muted);">→</span>
          <span style="font-size:1rem;font-weight:900;color:${color};">${fmt12(l.timeTo)}</span>
        </div>
        <div style="font-size:0.8rem;font-weight:700;flex:1;color:var(--text-main);">${_esc(tName)} · ${_esc(l.subject||gName)} · ${_esc(grpName)}</div>
        <div style="display:flex;gap:4px;">
          <button onclick="HallsModule.openEditLessonModal('${l.id}')"
            style="padding:4px 9px;border:none;background:var(--primary);color:white;border-radius:7px;cursor:pointer;font-size:0.72rem;">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="HallsModule.deleteLesson('${l.id}')"
            style="padding:4px 9px;border:none;background:#fef2f2;color:#ef4444;border-radius:7px;cursor:pointer;font-size:0.72rem;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════
  //  CENTRAL SCHEDULE TAB
  // ══════════════════════════════════════════════════════════
  function renderCentralSchedule(){
    const sorted=[...lessons].sort((a,b)=>DAY_KEYS.indexOf(a.day)-DAY_KEYS.indexOf(b.day)||toMin(a.timeFrom)-toMin(b.timeFrom));

    return `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:0.75rem;">
        <div style="font-size:0.95rem;font-weight:800;color:var(--text-main);">
          <i class="fas fa-calendar-week" style="color:var(--primary);margin-left:6px;"></i>
          الجدول المركزي للحصص (${lessons.length})
        </div>
        <button onclick="HallsModule.openAddLessonModal()"
          style="padding:0.55rem 1.2rem;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.88rem;">
          <i class="fas fa-plus"></i> إضافة حصة
        </button>
      </div>

      <!-- Filter by day -->
      <div style="display:flex;gap:0.4rem;margin-bottom:1rem;flex-wrap:wrap;">
        <button onclick="HallsModule._filterDay('')" id="day-filter-all"
          style="padding:4px 12px;border-radius:20px;border:1.5px solid var(--primary);background:var(--primary);color:white;cursor:pointer;font-size:0.78rem;font-weight:700;">كل الأيام</button>
        ${DAY_KEYS.map((dk,i)=>`
          <button onclick="HallsModule._filterDay('${dk}')" id="day-filter-${dk}"
            style="padding:4px 12px;border-radius:20px;border:1.5px solid var(--border);background:var(--bg-white);color:var(--text-muted);cursor:pointer;font-size:0.78rem;font-weight:700;">
            ${ARABIC_DAYS[i]}
          </button>`).join('')}
      </div>

      <div id="lessons-list">
        ${sorted.length===0
          ?`<div style="text-align:center;padding:3rem;color:var(--text-muted);">
              <i class="fas fa-calendar-times" style="font-size:2.5rem;opacity:0.3;display:block;margin-bottom:1rem;"></i>
              <p>لا توجد حصص مضافة بعد</p>
            </div>`
          :sorted.map(l=>_centralLessonRow(l)).join('')}
      </div>`;
  }

  function _filterDay(day){
    // Update button styles
    document.querySelectorAll('[id^="day-filter-"]').forEach(btn=>{
      btn.style.background='var(--bg-white)';btn.style.color='var(--text-muted)';btn.style.borderColor='var(--border)';
    });
    const activeId=day?`day-filter-${day}`:'day-filter-all';
    const activeBtn=document.getElementById(activeId);
    if(activeBtn){activeBtn.style.background='var(--primary)';activeBtn.style.color='white';}

    const filtered=day?lessons.filter(l=>l.day===day):[...lessons];
    const sorted=filtered.sort((a,b)=>DAY_KEYS.indexOf(a.day)-DAY_KEYS.indexOf(b.day)||toMin(a.timeFrom)-toMin(b.timeFrom));
    const container=document.getElementById('lessons-list');
    if(container) container.innerHTML=sorted.map(l=>_centralLessonRow(l)).join('') ||
      `<div style="text-align:center;padding:2rem;color:var(--text-muted);">لا توجد حصص في هذا اليوم</div>`;
  }

  function _centralLessonRow(l){
    const dayLabel=ARABIC_DAYS[DAY_KEYS.indexOf(l.day)]||l.day;
    const hall=halls.find(h=>String(h.id)===String(l.hallId));
    const color=hall?hallColor(hall):'#8b5cf6';
    const tName=teacherName(l.teacherId);
    const grpName=groupName(l.groupId);
    const gName=gradeName(l.grade);
    const todayKey=DAY_KEYS[new Date().getDay()];
    const isToday=l.day===todayKey;

    return `
      <div style="display:flex;align-items:center;gap:0.85rem;padding:0.9rem 1.1rem;background:var(--bg-white);
        border-radius:13px;margin-bottom:0.5rem;box-shadow:0 1px 6px rgba(0,0,0,0.05);flex-wrap:wrap;
        border-right:4px solid ${color};${isToday?'border:1.5px solid '+color+';border-right:4px solid '+color+';':''}">
        <!-- اليوم -->
        <div style="min-width:70px;">
          <span style="padding:3px 9px;border-radius:20px;font-size:0.72rem;font-weight:700;
            background:${color}20;color:${color};">${_esc(dayLabel)}</span>
          ${isToday?'<div style="margin-top:3px;"><span style="padding:2px 6px;border-radius:20px;font-size:0.62rem;font-weight:700;background:#10b981;color:white;">اليوم</span></div>':''}
        </div>
        <!-- الوقت بارز بنظام 12 ساعة -->
        <div style="display:flex;align-items:baseline;gap:4px;min-width:160px;">
          <span style="font-size:1.1rem;font-weight:900;color:${color};">${fmt12(l.timeFrom)}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);">→</span>
          <span style="font-size:1.1rem;font-weight:900;color:${color};">${fmt12(l.timeTo)}</span>
        </div>
        <!-- المدرس والمادة -->
        <div style="flex:1;min-width:140px;">
          <div style="font-size:0.85rem;font-weight:800;color:var(--text-main);">
            <i class="fas fa-chalkboard-teacher" style="color:#4f46e5;margin-left:4px;font-size:0.78rem;"></i>${_esc(tName)}
          </div>
          <div style="font-size:0.75rem;color:var(--text-muted);">${_esc(l.subject||gName)} · ${_esc(grpName)}</div>
        </div>
        <!-- القاعة -->
        <div style="font-size:0.8rem;font-weight:700;color:${color};">
          <i class="fas fa-door-open" style="font-size:0.72rem;margin-left:3px;"></i>${_esc(hall?hall.name:'---')}
        </div>
        <div style="display:flex;gap:5px;">
          <button onclick="HallsModule.openEditLessonModal('${l.id}')"
            style="padding:5px 10px;border:none;background:var(--primary);color:white;border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="HallsModule.deleteLesson('${l.id}')"
            style="padding:5px 10px;border:none;background:#fef2f2;color:#ef4444;border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  // ══════════════════════════════════════════════════════════
  //  DASHBOARD TAB
  // ══════════════════════════════════════════════════════════
  function renderDashboard(){
    const todayKey=DAY_KEYS[new Date().getDay()];
    const todayLessons=lessons.filter(l=>l.day===todayKey)
      .sort((a,b)=>toMin(a.timeFrom)-toMin(b.timeFrom));
    const upcomingLessons=lessons.filter(l=>{
      const dayIdx=DAY_KEYS.indexOf(l.day);
      const todayIdx=new Date().getDay();
      return dayIdx>todayIdx;
    }).sort((a,b)=>DAY_KEYS.indexOf(a.day)-DAY_KEYS.indexOf(b.day)||toMin(a.timeFrom)-toMin(b.timeFrom)).slice(0,10);

    // Teacher summary
    const teacherStats=teachers.map(t=>{
      const tLessons=lessons.filter(l=>String(l.teacherId)===String(t.id));
      const weeklyCount=tLessons.length;
      return {t, weeklyCount, lessons:tLessons};
    });

    // Hall status
    const hallStatus=halls.map(h=>{
      const hLessons=lessons.filter(l=>String(l.hallId)===String(h.id));
      const todayH=hLessons.filter(l=>l.day===todayKey);
      const groups=new Set(hLessons.map(l=>l.groupId).filter(Boolean));
      return {h, hLessons, todayH, groups};
    });

    return `
      <!-- Today's Lessons -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 8px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-day" style="margin-left:6px;"></i> حصص اليوم (${todayLessons.length})
        </h3>
        ${todayLessons.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem;">لا توجد حصص مجدولة اليوم</p>`
          :todayLessons.map(l=>{
            const hall=halls.find(h=>String(h.id)===String(l.hallId));
            const color=hall?hallColor(hall):'#8b5cf6';
            const now=new Date();
            const curMin=now.getHours()*60+now.getMinutes();
            const lFrom=toMin(l.timeFrom), lTo=toMin(l.timeTo);
            const isNow=curMin>=lFrom&&curMin<lTo;
            return `
              <div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem;border-radius:11px;
                background:${isNow?color+'15':'var(--bg-light)'};border:${isNow?'1.5px solid '+color:'1.5px solid transparent'};margin-bottom:0.4rem;flex-wrap:wrap;">
                <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></div>
                <div style="font-weight:900;font-size:0.92rem;color:${color};min-width:110px;">
                  ${fmt12(l.timeFrom)} → ${fmt12(l.timeTo)}
                  ${isNow?'<span style="background:'+color+';color:white;border-radius:10px;padding:1px 6px;font-size:0.65rem;margin-right:4px;">جارية</span>':''}
                </div>
                <div style="flex:1;font-size:0.82rem;">
                  <strong>${_esc(teacherName(l.teacherId))}</strong> · ${_esc(l.subject||gradeName(l.grade))} · ${_esc(groupName(l.groupId))}
                </div>
                <div style="font-size:0.78rem;color:${color};font-weight:700;">
                  <i class="fas fa-door-open" style="margin-left:3px;font-size:0.7rem;"></i>${_esc(hall?hall.name:'---')}
                </div>
              </div>`;
          }).join('')}
      </div>

      <!-- Upcoming Lessons -->
      ${upcomingLessons.length>0?`
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 8px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-clock" style="margin-left:6px;"></i> الحصص القادمة هذا الأسبوع
        </h3>
        ${upcomingLessons.map(l=>{
          const hall=halls.find(h=>String(h.id)===String(l.hallId));
          const color=hall?hallColor(hall):'#8b5cf6';
          const dayLabel=ARABIC_DAYS[DAY_KEYS.indexOf(l.day)]||l.day;
          return `
            <div style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem;border-radius:10px;background:var(--bg-light);margin-bottom:0.35rem;flex-wrap:wrap;">
              <span style="padding:2px 9px;border-radius:20px;font-size:0.72rem;font-weight:700;background:${color}20;color:${color};">${dayLabel}</span>
              <span style="font-size:0.85rem;font-weight:800;color:${color};">${fmt12(l.timeFrom)} → ${fmt12(l.timeTo)}</span>
              <span style="font-size:0.82rem;font-weight:700;flex:1;">${_esc(teacherName(l.teacherId))} · ${_esc(l.subject||gradeName(l.grade))}</span>
              <span style="font-size:0.78rem;color:${color};">${_esc(hall?hall.name:'---')}</span>
            </div>`;
        }).join('')}
      </div>`:``}

      <!-- Halls Status -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.2rem;box-shadow:0 1px 8px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-building" style="margin-left:6px;"></i> حالة القاعات اليوم
        </h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.75rem;">
          ${hallStatus.map(({h,hLessons,todayH,groups})=>{
            const color=hallColor(h);
            const busy=todayH.length>0;
            return `
              <div style="border-radius:12px;padding:0.9rem;background:${busy?color+'12':'#f0fdf4'};border:1.5px solid ${busy?color+'40':'#bbf7d0'};">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                  <div style="font-weight:800;font-size:0.88rem;">${_esc(h.name)}</div>
                  <span style="padding:2px 8px;border-radius:20px;font-size:0.7rem;font-weight:700;
                    background:${busy?'#fef2f2':'#f0fdf4'};color:${busy?'#ef4444':'#16a34a'};">
                    ${busy?'مشغولة':'متاحة'}
                  </span>
                </div>
                <div style="font-size:0.75rem;color:var(--text-muted);">
                  ${h.capacity?`السعة: ${h.capacity} | `:''}${hLessons.length} حصة/أسبوع
                  ${todayH.length?` | ${todayH.length} حصة اليوم`:''}
                </div>
                ${todayH.map(l=>`
                  <div style="font-size:0.78rem;margin-top:4px;color:${color};font-weight:800;">
                    ${fmt12(l.timeFrom)} → ${fmt12(l.timeTo)}<span style="font-weight:600;color:var(--text-muted);font-size:0.7rem;"> · ${_esc(teacherName(l.teacherId))}</span>
                  </div>`).join('')}
              </div>`;
          }).join('')}
        </div>
      </div>

      <!-- Teachers Summary -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;box-shadow:0 1px 8px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-chalkboard-teacher" style="margin-left:6px;"></i> ملخص جداول المدرسين
        </h3>
        ${teacherStats.length===0
          ?`<p style="color:var(--text-muted);font-size:0.85rem;">لا يوجد مدرسون مضافون</p>`
          :`<div style="overflow-x:auto;">
              <table style="width:100%;border-collapse:collapse;font-size:0.83rem;min-width:450px;">
                <thead>
                  <tr style="background:var(--bg-light);">
                    <th style="padding:8px 12px;text-align:right;">المدرس</th>
                    <th style="padding:8px 12px;text-align:center;">المادة</th>
                    <th style="padding:8px 12px;text-align:center;">حصص/أسبوع</th>
                    <th style="padding:8px 12px;text-align:center;">أيام التدريس</th>
                  </tr>
                </thead>
                <tbody>
                  ${teacherStats.map(({t,weeklyCount,lessons:tLessons})=>{
                    const activeDays=[...new Set(tLessons.map(l=>ARABIC_DAYS[DAY_KEYS.indexOf(l.day)]))].join('، ');
                    return `
                      <tr style="border-bottom:1px solid var(--bg-light);">
                        <td style="padding:8px 12px;font-weight:700;">${_esc(t.name)}</td>
                        <td style="padding:8px 12px;text-align:center;color:var(--text-muted);">${_esc(t.subject||'---')}</td>
                        <td style="padding:8px 12px;text-align:center;font-weight:800;color:var(--primary);">${weeklyCount}</td>
                        <td style="padding:8px 12px;text-align:center;font-size:0.77rem;">${activeDays||'---'}</td>
                      </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>`}
      </div>`;
  }

  // ══════════════════════════════════════════════════════════
  //  HALL MODAL (Add/Edit)
  // ══════════════════════════════════════════════════════════
  function openAddHallModal(){ editingHallId=null; _showHallModal({name:'',capacity:'',color:HALL_COLORS[0]}); }
  function openEditHallModal(id){
    editingHallId=id;
    const hall=halls.find(h=>String(h.id)===String(id));
    if(hall) _showHallModal(hall);
  }
  function _showHallModal(hall){
    _removeModal('hall-name-modal');
    const modal=document.createElement('div');
    modal.id='hall-name-modal';
    modal.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
    modal.innerHTML=`
      <div style="background:var(--bg-white,#fff);border-radius:20px;padding:1.8rem;max-width:440px;width:95%;direction:rtl;font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,0.25);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
          <h3 style="margin:0;font-size:1.05rem;font-weight:800;color:var(--primary);">
            <i class="fas fa-door-open"></i> ${editingHallId?'تعديل القاعة':'إضافة قاعة جديدة'}
          </h3>
          <button onclick="document.getElementById('hall-name-modal').remove()"
            style="background:var(--bg-light,#f1f5f9);border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:5px;">اسم القاعة *</label>
        <input id="hall-modal-name" type="text" value="${_esc(hall.name||'')}" placeholder="مثال: قاعة A — القاعة الكبيرة"
          style="width:100%;padding:0.75rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.95rem;box-sizing:border-box;margin-bottom:1rem;outline:none;">

        <label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:5px;">السعة القصوى (عدد الطلاب)</label>
        <input id="hall-modal-capacity" type="number" min="1" value="${_esc(String(hall.capacity||''))}" placeholder="مثال: 50"
          style="width:100%;padding:0.75rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.95rem;box-sizing:border-box;margin-bottom:1rem;outline:none;">

        <label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:8px;">لون القاعة</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1.4rem;">
          ${HALL_COLORS.map(c=>`
            <div onclick="document.querySelectorAll('.hall-color-dot').forEach(d=>d.style.transform='');this.style.transform='scale(1.2)';window._selectedHallColor='${c}'"
              class="hall-color-dot"
              style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;
                border:2px solid ${c===(hall.color||HALL_COLORS[0])?'white':'transparent'};
                box-shadow:${c===(hall.color||HALL_COLORS[0])?'0 0 0 2px '+c:'none'};
                transform:${c===(hall.color||HALL_COLORS[0])?'scale(1.2)':''};transition:all 0.15s;">
            </div>`).join('')}
        </div>

        <div style="display:flex;gap:0.75rem;">
          <button onclick="HallsModule.saveHallModal()"
            style="flex:1;padding:0.8rem;border:none;border-radius:10px;background:var(--primary);color:white;font-weight:700;cursor:pointer;font-family:inherit;">
            <i class="fas fa-save"></i> ${editingHallId?'حفظ التعديل':'إضافة القاعة'}
          </button>
          <button onclick="document.getElementById('hall-name-modal').remove()"
            style="padding:0.8rem 1rem;border:none;border-radius:10px;background:var(--bg-light,#f1f5f9);cursor:pointer;font-family:inherit;">
            إلغاء
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
    window._selectedHallColor=hall.color||HALL_COLORS[0];
    setTimeout(()=>document.getElementById('hall-modal-name')?.focus(),80);
  }

  async function saveHallModal(){
    const name=document.getElementById('hall-modal-name')?.value.trim();
    const capacity=parseInt(document.getElementById('hall-modal-capacity')?.value)||0;
    const color=window._selectedHallColor||HALL_COLORS[0];
    if(!name) return notify('يرجى كتابة اسم للقاعة','error');

    if(editingHallId){
      const hall=halls.find(h=>String(h.id)===String(editingHallId));
      if(!hall) return;
      hall.name=name; hall.capacity=capacity; hall.color=color;
      await _save('halls',hall);
      notify('✅ تم تحديث بيانات القاعة');
    } else {
      const hall={id:Date.now(),name,capacity,color,createdAt:new Date().toISOString()};
      halls.push(hall);
      await _save('halls',hall);
      notify('✅ تمت إضافة القاعة بنجاح');
    }
    _removeModal('hall-name-modal');
    renderHallsSection();
  }

  async function deleteHall(id){
    const hall=halls.find(h=>String(h.id)===String(id));
    if(!hall) return;
    const count=lessons.filter(l=>String(l.hallId)===String(id)).length;
    if(!confirm(`حذف "${hall.name}"${count?` وكل حصصها (${count} حصة)`:''}؟`)) return;
    for(const l of lessons.filter(x=>String(x.hallId)===String(id))) await _del('lessons',l.id);
    lessons=lessons.filter(l=>String(l.hallId)!==String(id));
    await _del('halls',id);
    halls=halls.filter(h=>String(h.id)!==String(id));
    notify('تم حذف القاعة');
    renderHallsSection();
  }

  // ══════════════════════════════════════════════════════════
  //  LESSON MODAL (Add/Edit) — Central Schedule
  // ══════════════════════════════════════════════════════════
  function openAddLessonModal(hallId='', presetDay=''){
    editingLessonId=null;
    _showLessonModal({hallId:hallId||'',day:presetDay,timeFrom:'',timeTo:'',teacherId:'',subject:'',grade:'',groupId:'',notes:''});
  }
  function openEditLessonModal(id){
    editingLessonId=id;
    const l=lessons.find(x=>String(x.id)===String(id));
    if(l) _showLessonModal(l);
  }

  function _showLessonModal(l){
    _removeModal('lesson-modal');
    const modal=document.createElement('div');
    modal.id='lesson-modal';
    modal.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);overflow-y:auto;';
    modal.innerHTML=`
      <div style="background:var(--bg-white,#fff);border-radius:20px;padding:1.8rem;max-width:540px;width:96%;max-height:92vh;overflow-y:auto;direction:rtl;font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,0.28);margin:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
          <h3 style="margin:0;font-size:1.05rem;font-weight:800;color:var(--primary);">
            <i class="fas fa-calendar-plus"></i> ${editingLessonId?'تعديل الحصة':'إضافة حصة جديدة'}
          </h3>
          <button onclick="document.getElementById('lesson-modal').remove()"
            style="background:var(--bg-light,#f1f5f9);border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- Row: Teacher + Subject -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">👤 المدرس</label>
            <select id="ls-teacher"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;background:var(--bg-white);">
              ${buildTeacherOptions(l.teacherId)}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">📚 المادة</label>
            <input id="ls-subject" type="text" value="${_esc(l.subject||'')}" placeholder="مثال: الفيزياء"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;box-sizing:border-box;">
          </div>
        </div>

        <!-- Row: Grade + Group -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🎓 المرحلة/الصف</label>
            <select id="ls-grade" onchange="HallsModule._onLsGradeChange()"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;background:var(--bg-white);">
              <option value="">-- اختر الصف --</option>
              ${buildGradeOptions(l.grade)}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">👥 المجموعة (اكتب الاسم)</label>
            <input id="ls-group" type="text" list="ls-group-suggestions" autocomplete="off"
              value="${_esc((()=>{ if(!l.groupId) return ''; const g=(window.db&&db.groups||[]).find(x=>String(x.id)===String(l.groupId)); return g?g.name:''; })())}"
              placeholder="مثال: مجموعة الأحد"
              onchange="HallsModule._onLsGroupChange()" oninput="HallsModule._onLsGroupChange()"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;background:var(--bg-white);box-sizing:border-box;">
            <datalist id="ls-group-suggestions">
              ${(window.GradeGroupLinkSystem?window.GradeGroupLinkSystem.listGroupNamesForGrade(l.grade):[]).map(n=>`<option value="${_esc(n)}">`).join('')}
            </datalist>
          </div>
        </div>

        <!-- Row: Hall + Day -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🏫 القاعة</label>
            <select id="ls-hall" onchange="HallsModule._onLsHallChange()"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;background:var(--bg-white);">
              ${buildHallOptions(l.hallId)}
            </select>
          </div>
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">📅 اليوم</label>
            <select id="ls-day" onchange="HallsModule._lsCheckConflicts()"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;background:var(--bg-white);">
              <option value="">-- اختر اليوم --</option>
              ${DAY_KEYS.map((dk,i)=>`<option value="${dk}" ${dk===l.day?'selected':''}>${ARABIC_DAYS[i]}</option>`).join('')}
            </select>
          </div>
        </div>

        <!-- Row: Time -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🕐 من</label>
            <input id="ls-from" type="time" value="${_esc(l.timeFrom||'')}" onchange="HallsModule._lsCheckConflicts()"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;box-sizing:border-box;">
          </div>
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🕕 إلى</label>
            <input id="ls-to" type="time" value="${_esc(l.timeTo||'')}" onchange="HallsModule._lsCheckConflicts()"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;box-sizing:border-box;">
          </div>
        </div>

        <!-- Conflict Zone -->
        <div id="ls-conflicts" style="display:none;margin-bottom:1rem;"></div>

        <!-- Capacity Warning -->
        <div id="ls-capacity-warn" style="display:none;background:#fef3c7;border:1.5px solid #fbbf24;border-radius:10px;padding:0.7rem 1rem;margin-bottom:1rem;font-size:0.83rem;color:#92400e;">
          <i class="fas fa-exclamation-triangle"></i> <span id="ls-capacity-msg"></span>
        </div>

        <!-- Notes -->
        <div style="margin-bottom:1.4rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">📝 ملاحظات (اختياري)</label>
          <input id="ls-notes" type="text" value="${_esc(l.notes||'')}" placeholder="أي ملاحظة إضافية..."
            style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.88rem;box-sizing:border-box;">
        </div>

        <div style="display:flex;gap:0.75rem;">
          <button onclick="HallsModule.saveLessonModal()"
            style="flex:1;padding:0.8rem;border:none;border-radius:10px;background:var(--primary);color:white;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.9rem;">
            <i class="fas fa-save"></i> ${editingLessonId?'حفظ التعديل':'حفظ الحصة'}
          </button>
          <button onclick="document.getElementById('lesson-modal').remove()"
            style="padding:0.8rem 1rem;border:none;border-radius:10px;background:var(--bg-light,#f1f5f9);cursor:pointer;font-family:inherit;">
            إلغاء
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
    setTimeout(()=>document.getElementById('ls-teacher')?.focus(),80);
  }

  function _onLsGradeChange(){
    const grade=document.getElementById('ls-grade')?.value||'';
    const dl=document.getElementById('ls-group-suggestions');
    if(dl){
      const names=window.GradeGroupLinkSystem?window.GradeGroupLinkSystem.listGroupNamesForGrade(grade):[];
      dl.innerHTML=names.map(n=>`<option value="${_esc(n)}">`).join('');
    }
    _onLsGroupChange();
  }
  function _onLsGroupChange(){
    const hallId=document.getElementById('ls-hall')?.value||'';
    const grade=document.getElementById('ls-grade')?.value||'';
    const groupName_=document.getElementById('ls-group')?.value.trim()||'';
    const warn=document.getElementById('ls-capacity-warn');
    if(!hallId||!groupName_||!grade){ if(warn) warn.style.display='none'; return; }

    // نبحث عن مجموعة موجودة فعلاً بنفس الاسم في نفس الصف — لو لسه
    // مكتوبة جديدة (مش متعملة) مفيش لسه طلاب فيها، فمفيش داعي للتحذير.
    const existing=(window.db&&db.groups||[]).find(g=>
      window.GradeGroupLinkSystem.groupParentKey(g)===window.GradeGroupLinkSystem.keyOf(grade) &&
      String(g.name||'').trim().toLowerCase()===groupName_.toLowerCase()
    );
    if(!existing){ if(warn) warn.style.display='none'; return; }

    const cap=checkCapacity(hallId,existing.id);
    const msg=document.getElementById('ls-capacity-msg');
    if(warn&&msg){
      if(cap.over){
        warn.style.display='block';
        msg.textContent=`تحذير: عدد طلاب المجموعة (${cap.count}) يتجاوز سعة القاعة (${cap.cap} طالب). لن يُسمح بالحجز إلا بموافقة المشرف.`;
      } else {
        warn.style.display='none';
      }
    }
  }
  function _onLsHallChange(){ _lsCheckConflicts(); _onLsGroupChange(); }

  function _lsCheckConflicts(){
    const hallId=document.getElementById('ls-hall')?.value;
    const teacherId=document.getElementById('ls-teacher')?.value;
    const day=document.getElementById('ls-day')?.value;
    const from=document.getElementById('ls-from')?.value;
    const to=document.getElementById('ls-to')?.value;
    const zone=document.getElementById('ls-conflicts');
    if(!zone) return;

    const msgs=[];

    if(day&&from&&to){
      if(toMin(to)<=toMin(from)){
        msgs.push({text:'⚠️ وقت النهاية يجب أن يكون بعد وقت البداية',color:'#fef2f2',border:'#fca5a5',txt:'#991b1b'});
      } else {
        if(hallId){
          const hc=detectHallConflict(hallId,day,from,to,editingLessonId);
          if(hc.conflict){
            const cw=hc.with;
            msgs.push({text:`❌ تعارض في القاعة: ${ARABIC_DAYS[DAY_KEYS.indexOf(cw.day)]} ${cw.timeFrom}–${cw.timeTo} (${teacherName(cw.teacherId)})`,color:'#fef2f2',border:'#fca5a5',txt:'#991b1b'});
          }
        }
        if(teacherId){
          const tc=detectTeacherConflict(teacherId,day,from,to,editingLessonId);
          if(tc.conflict){
            const cw=tc.with;
            msgs.push({text:`❌ تعارض مع جدول المدرس: ${ARABIC_DAYS[DAY_KEYS.indexOf(cw.day)]} ${cw.timeFrom}–${cw.timeTo} في ${halls.find(h=>String(h.id)===String(cw.hallId))?.name||'---'}`,color:'#fef2f2',border:'#fca5a5',txt:'#991b1b'});
          }
        }
      }
    }

    if(msgs.length>0){
      zone.style.display='block';
      zone.innerHTML=msgs.map(m=>`
        <div style="background:${m.color};border:1.5px solid ${m.border};border-radius:10px;padding:0.65rem 1rem;margin-bottom:0.4rem;color:${m.txt};font-size:0.83rem;">
          ${m.text}
        </div>`).join('');
    } else {
      zone.style.display='none';
      zone.innerHTML='';
    }
  }

  async function saveLessonModal(){
    const hallId=document.getElementById('ls-hall')?.value;
    const teacherId=document.getElementById('ls-teacher')?.value||'';
    const subject=document.getElementById('ls-subject')?.value.trim()||'';
    const grade=document.getElementById('ls-grade')?.value||'';
    const groupNameTyped=document.getElementById('ls-group')?.value.trim()||'';
    const day=document.getElementById('ls-day')?.value;
    const timeFrom=document.getElementById('ls-from')?.value;
    const timeTo=document.getElementById('ls-to')?.value;
    const notes=document.getElementById('ls-notes')?.value.trim()||'';

    if(!day) return notify('يرجى اختيار اليوم','error');
    if(!timeFrom) return notify('يرجى تحديد وقت البداية','error');
    if(!timeTo) return notify('يرجى تحديد وقت النهاية','error');
    if(toMin(timeTo)<=toMin(timeFrom)) return notify('وقت النهاية يجب أن يكون بعد وقت البداية','error');
    if(groupNameTyped&&!grade) return notify('يرجى اختيار الصف الدراسي أولاً قبل كتابة اسم المجموعة','error');

    // اسم المجموعة المكتوب يتحول لمجموعة حقيقية (موجودة بالفعل أو
    // بتتعمل دلوقتي) قبل أي فحص تعارض/سعة، عشان الـ ID يكون جاهز.
    let groupId=null;
    if(groupNameTyped&&grade){
      const grp=await window.GradeGroupLinkSystem.findOrCreateGroupByName(grade,groupNameTyped);
      groupId=grp?grp.id:null;
    }

    const errors=[];

    if(hallId){
      const hc=detectHallConflict(hallId,day,timeFrom,timeTo,editingLessonId);
      if(hc.conflict){
        const cw=hc.with;
        errors.push(`تعارض في القاعة: ${ARABIC_DAYS[DAY_KEYS.indexOf(cw.day)]} ${cw.timeFrom}–${cw.timeTo} (${teacherName(cw.teacherId)})`);
      }
    }
    if(teacherId){
      const tc=detectTeacherConflict(teacherId,day,timeFrom,timeTo,editingLessonId);
      if(tc.conflict){
        const cw=tc.with;
        errors.push(`تعارض مع جدول المدرس: ${ARABIC_DAYS[DAY_KEYS.indexOf(cw.day)]} ${cw.timeFrom}–${cw.timeTo}`);
      }
    }
    if(hallId&&groupId){
      const cap=checkCapacity(hallId,groupId);
      if(cap.over) errors.push(`عدد طلاب المجموعة (${cap.count}) يتجاوز سعة القاعة (${cap.cap})`);
    }

    if(errors.length>0) return notify('❌ '+errors.join(' | '),'error');

    if(editingLessonId){
      const lesson=lessons.find(x=>String(x.id)===String(editingLessonId));
      if(!lesson) return;
      Object.assign(lesson,{hallId:hallId||null,teacherId:teacherId||null,subject,grade,groupId:groupId||null,day,timeFrom,timeTo,notes});
      await _save('lessons',lesson);
      notify('✅ تم تحديث الحصة');
    } else {
      const lesson={id:Date.now(),hallId:hallId||null,teacherId:teacherId||null,subject,grade,groupId:groupId||null,day,timeFrom,timeTo,notes,createdAt:new Date().toISOString()};
      lessons.push(lesson);
      await _save('lessons',lesson);
      notify('✅ تمت إضافة الحصة');
    }

    _removeModal('lesson-modal');
    renderHallsSection();
    if(activeHallId) setTimeout(()=>openHallDetail(activeHallId),50);
  }

  async function deleteLesson(id){
    const l=lessons.find(x=>String(x.id)===String(id));
    if(!l) return;
    const dayL=ARABIC_DAYS[DAY_KEYS.indexOf(l.day)]||l.day;
    if(!confirm(`حذف هذه الحصة؟\n${dayL} · ${l.timeFrom}–${l.timeTo} · ${teacherName(l.teacherId)}`)) return;
    await _del('lessons',l.id);
    lessons=lessons.filter(x=>String(x.id)!==String(id));
    notify('تم حذف الحصة');
    renderHallsSection();
    if(activeHallId) setTimeout(()=>openHallDetail(activeHallId),50);
  }

  // ── Helper: remove modal ──
  function _removeModal(id){ const el=document.getElementById(id); if(el) el.remove(); }

  // ── Entry point ──
  async function initHallsSection(){
    await loadData();
    renderHallsSection();
  }

  // ── Ensure nav and section exist ──
  function ensureHallsSection(){
    if(document.getElementById('halls-section')) return;
    // Section is already in index.html, just need halls-content
  }
  function ensureHallsNav(){ /* nav is in index.html */ }

  // ── Public API ──
  // ملحوظة: نظام ربط الصف↔المجموعة بقى موحّد في window.GradeGroupLinkSystem
  // (معرّف في app.js)، مش هنا. حذفنا التصدير القديم لـ gradeKey/groupGradeKey
  // بعد ما شلنا التنفيذ المحلي بالكامل.

  window.HallsModule = {
    init: initHallsSection,
    ensureUI(){ ensureHallsNav(); ensureHallsSection(); },
    openAddHallModal,
    openEditHallModal,
    saveHallModal,
    deleteHall,
    openHallDetail,
    openAddLessonModal,
    openEditLessonModal,
    saveLessonModal,
    deleteLesson,
    showTab,
    _filterDay,
    _onLsGradeChange,
    _onLsGroupChange,
    _onLsHallChange,
    _lsCheckConflicts,
    // Expose lessons for TeachersModule
    getLessons: ()=>lessons,
    getHalls: ()=>halls,
    // يعيد تحميل بيانات القاعات/الحصص من التخزين — تستخدمها وحدة
    // المدرسين (teachers.js) بعد حفظ/حذف جدول مدرس مباشرة في مخزن
    // lessons، عشان تفضل بيانات هذه الوحدة متزامنة فورًا من غير ما
    // يحتاج المستخدم يزور قسم القاعات الأول.
    reload: async()=>{ await loadData(); },
  };

  document.addEventListener('DOMContentLoaded',()=>{ console.log('[halls.js] v2.0 ✅ جاهز'); });
})();
