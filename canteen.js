// ============================================================
//  canteen.js  —  نظام حساب الكانتين
//  Canteen POS & Inventory System
//
//  الميزات:
//    • إضافة / تعديل / حذف أصناف بسعر تكلفة وسعر بيع
//    • شاشة بيع سريعة: اختر الصنف → حدد الكمية → بيع
//    • تسجيل فوري لكل عملية بيع مع الوقت والتاريخ
//    • تقارير: مبيعات اليوم + إجمالي + الأرباح + الأكثر مبيعاً
//    • تخزين كامل في IndexedDB عبر StorageEngine
//
//  جداول IndexedDB (مُعرَّفة في app.js v9):
//    canteenItems : { id, name, category, costPrice, salePrice,
//                     emoji, isActive, createdAt }
//    canteenSales : { id, itemId, itemName, qty, unitPrice,
//                     totalPrice, profit, date, createdAt }
// ============================================================

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     حالة الوحدة
  ══════════════════════════════════════════════════════════ */
  let items        = [];   // أصناف الكانتين
  let sales        = [];   // سجل المبيعات
  let activeView   = 'pos'; // 'pos' | 'items' | 'reports'
  let editingItemId = null;

  // أيقونات الأصناف المقترحة
  const ITEM_EMOJIS = ['🍟','🧃','🥤','🍕','🍔','🌯','🧁','🍫','🍬','🥜','🍿','🧊','☕','🍩','🧆','🥐','🍪','🍭'];

  const CATEGORIES = ['مشروبات','أكل خفيف','حلويات','وجبات','أخرى'];

  /* ══════════════════════════════════════════════════════════
     StorageEngine helpers
  ══════════════════════════════════════════════════════════ */
  async function ensureReady() {
    if (!window.StorageEngine) return;
    if (!StorageEngine.db) await StorageEngine.init();
  }

  async function loadData() {
    await ensureReady();
    try {
      items = await StorageEngine.getAll('canteenItems') || [];
      sales = await StorageEngine.getAll('canteenSales') || [];
    } catch (e) {
      console.warn('[Canteen] loadData failed:', e);
      items = []; sales = [];
    }
  }

  async function saveItem(item) {
    await ensureReady();
    await StorageEngine.save('canteenItems', item);
  }

  async function saveSale(sale) {
    await ensureReady();
    await StorageEngine.save('canteenSales', sale);
  }

  async function deleteItemDB(id) {
    await ensureReady();
    await StorageEngine.delete('canteenItems', id);
  }

  /* ══════════════════════════════════════════════════════════
     مساعدات عامة
  ══════════════════════════════════════════════════════════ */
  function notify(msg, type = 'success') {
    if (typeof showNotification === 'function') showNotification(msg, type);
  }

  function fmt(num) {
    return Number(num || 0).toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  function todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function todaySales() {
    const t = todayStr();
    return sales.filter(s => (s.date || s.createdAt || '').startsWith(t));
  }

  /* ══════════════════════════════════════════════════════════
     الواجهة الرئيسية
  ══════════════════════════════════════════════════════════ */
  function render() {
    const wrap = document.getElementById('canteen-content');
    if (!wrap) return;

    // ── شريط التبويبات ──
    const tabs = [
      { id:'pos',     icon:'fas fa-cash-register', label:'البيع السريع' },
      { id:'items',   icon:'fas fa-boxes',          label:'الأصناف'     },
      { id:'reports', icon:'fas fa-chart-bar',      label:'التقارير'    },
    ];

    wrap.innerHTML = `
      <!-- تبويبات -->
      <div style="display:flex;gap:0.5rem;margin-bottom:1.4rem;background:var(--bg-light);padding:5px;border-radius:14px;width:fit-content;">
        ${tabs.map(t => `
          <button onclick="CanteenModule._setView('${t.id}')"
            id="canteen-tab-${t.id}"
            style="padding:0.55rem 1.2rem;border:none;border-radius:10px;font-family:inherit;font-size:0.88rem;font-weight:700;cursor:pointer;transition:all 0.18s;
                   background:${activeView===t.id ? 'white' : 'transparent'};
                   color:${activeView===t.id ? 'var(--primary)' : 'var(--text-muted)'};
                   box-shadow:${activeView===t.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none'};">
            <i class="${t.icon}" style="margin-left:5px;"></i>${t.label}
          </button>`).join('')}
      </div>

      <!-- المحتوى -->
      <div id="canteen-view"></div>`;

    renderView();
  }

  function renderView() {
    const el = document.getElementById('canteen-view');
    if (!el) return;
    if (activeView === 'pos')     renderPOS(el);
    if (activeView === 'items')   renderItems(el);
    if (activeView === 'reports') renderReports(el);
  }

  /* ══════════════════════════════════════════════════════════
     شاشة البيع السريع (POS)
  ══════════════════════════════════════════════════════════ */
  function renderPOS(el) {
    const activeItems = items.filter(i => i.isActive !== false);
    const tSales = todaySales();
    const todayRevenue = tSales.reduce((a, s) => a + (s.totalPrice||0), 0);
    const todayProfit  = tSales.reduce((a, s) => a + (s.profit||0),     0);
    const todayCount   = tSales.reduce((a, s) => a + (s.qty||1),        0);

    // تجميع أفضل الأصناف اليوم
    const topMap = {};
    tSales.forEach(s => {
      topMap[s.itemName] = (topMap[s.itemName]||0) + s.qty;
    });
    const topItems = Object.entries(topMap).sort((a,b)=>b[1]-a[1]).slice(0,3);

    el.innerHTML = `
      <!-- إحصائيات اليوم -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:1.5rem;">
        ${_statCard('💰','إيرادات اليوم', fmt(todayRevenue)+' ج', '#16a34a')}
        ${_statCard('📈','أرباح اليوم',   fmt(todayProfit) +' ج', '#0ea5e9')}
        ${_statCard('🛍️','قطع مباعة',    todayCount+' قطعة',     '#f59e0b')}
        ${_statCard('📦','عدد الأصناف',   activeItems.length+' صنف', '#8b5cf6')}
      </div>

      ${topItems.length ? `
        <div style="background:linear-gradient(135deg,#fefce8,#fef9c3);border:1.5px solid #fde047;border-radius:14px;padding:0.9rem 1.1rem;margin-bottom:1.2rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap;">
          <span style="font-weight:800;color:#a16207;font-size:0.85rem;">🏆 الأكثر مبيعاً اليوم:</span>
          ${topItems.map((x,i)=>`<span style="background:white;border-radius:20px;padding:3px 12px;font-size:0.82rem;font-weight:700;color:#92400e;">${i===0?'🥇':i===1?'🥈':'🥉'} ${x[0]} (${x[1]})</span>`).join('')}
        </div>` : ''}

      <!-- شبكة الأصناف -->
      ${activeItems.length === 0 ? `
        <div style="text-align:center;padding:4rem;color:var(--text-muted);">
          <div style="font-size:3rem;margin-bottom:1rem;">🛒</div>
          <p style="font-weight:700;">لا توجد أصناف بعد</p>
          <p style="font-size:0.85rem;">اذهب إلى تبويب «الأصناف» لإضافة منتجات الكانتين</p>
          <button onclick="CanteenModule._setView('items')"
            style="margin-top:1rem;padding:0.65rem 1.5rem;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-family:inherit;">
            <i class="fas fa-plus"></i> إضافة أصناف
          </button>
        </div>` :
        `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:0.9rem;">
          ${activeItems.map(item => _itemPOSCard(item)).join('')}
        </div>`
      }

      <!-- آخر 5 مبيعات اليوم -->
      ${tSales.length > 0 ? `
        <div style="margin-top:1.5rem;">
          <div style="font-size:0.82rem;font-weight:800;color:var(--text-muted);margin-bottom:0.75rem;">
            <i class="fas fa-history"></i> آخر المبيعات اليوم
          </div>
          <div style="display:flex;flex-direction:column;gap:0.4rem;">
            ${[...tSales].reverse().slice(0,8).map(s => `
              <div style="display:flex;align-items:center;gap:0.8rem;padding:0.55rem 0.9rem;background:var(--bg-light);border-radius:10px;">
                <span style="font-size:1.1rem;">${items.find(i=>i.id==s.itemId)?.emoji||'📦'}</span>
                <span style="flex:1;font-weight:700;font-size:0.85rem;">${s.itemName}</span>
                <span style="color:var(--text-muted);font-size:0.8rem;">× ${s.qty}</span>
                <span style="font-weight:800;color:#16a34a;font-size:0.88rem;">${fmt(s.totalPrice)} ج</span>
                <span style="font-size:0.72rem;color:var(--text-muted);">${new Date(s.createdAt).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'})}</span>
                <button onclick="CanteenModule._deleteSale('${s.id}')" title="حذف"
                  style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.75rem;padding:2px 4px;">
                  <i class="fas fa-times"></i>
                </button>
              </div>`).join('')}
          </div>
        </div>` : ''}`;
  }

  function _statCard(icon, label, value, color) {
    return `
      <div style="background:var(--bg-white);border-radius:14px;padding:1.1rem 1.2rem;border:1.5px solid var(--border);box-shadow:0 2px 8px rgba(0,0,0,0.04);">
        <div style="font-size:1.6rem;margin-bottom:0.3rem;">${icon}</div>
        <div style="font-size:1.2rem;font-weight:800;color:${color};">${value}</div>
        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">${label}</div>
      </div>`;
  }

  function _itemPOSCard(item) {
    return `
      <div onclick="CanteenModule.openSellModal('${item.id}')"
        style="background:var(--bg-white);border:1.5px solid var(--border);border-radius:16px;padding:1.1rem 0.9rem;
               text-align:center;cursor:pointer;transition:all 0.18s;user-select:none;"
        onmouseover="this.style.transform='translateY(-3px)';this.style.boxShadow='0 8px 20px rgba(0,0,0,0.12)';this.style.borderColor='var(--primary)'"
        onmouseout="this.style.transform='';this.style.boxShadow='';this.style.borderColor='var(--border)'">
        <div style="font-size:2.4rem;margin-bottom:0.4rem;">${item.emoji||'📦'}</div>
        <div style="font-weight:800;font-size:0.88rem;color:var(--text-main);margin-bottom:4px;line-height:1.3;">${_esc(item.name)}</div>
        <div style="font-size:1.05rem;font-weight:800;color:#16a34a;">${fmt(item.salePrice)} ج</div>
        <div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">${_esc(item.category||'')}</div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════
     مودال البيع
  ══════════════════════════════════════════════════════════ */
  function openSellModal(itemId) {
    const item = items.find(i => String(i.id) === String(itemId));
    if (!item) return;

    _removeModal('canteen-sell-modal');
    const modal = document.createElement('div');
    modal.id = 'canteen-sell-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
    modal.innerHTML = `
      <div style="background:var(--bg-white,#fff);border-radius:22px;padding:2rem;max-width:380px;width:94%;direction:rtl;font-family:inherit;box-shadow:0 24px 60px rgba(0,0,0,0.28);">

        <!-- هيدر -->
        <div style="text-align:center;margin-bottom:1.4rem;">
          <div style="font-size:3.5rem;margin-bottom:0.4rem;">${item.emoji||'📦'}</div>
          <div style="font-size:1.15rem;font-weight:800;color:var(--text-main);">${_esc(item.name)}</div>
          <div style="font-size:0.85rem;color:var(--text-muted);margin-top:3px;">سعر القطعة: <b style="color:#16a34a;">${fmt(item.salePrice)} ج</b></div>
        </div>

        <!-- اختيار الكمية بأزرار سريعة -->
        <div style="margin-bottom:1.2rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:8px;color:var(--text-main);">الكمية</label>
          <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:8px;">
            ${[1,2,3,4,5].map(n=>`
              <button onclick="document.getElementById('sell-qty').value=${n};CanteenModule._updateSellTotal(${item.salePrice})"
                style="padding:0.6rem 0;border:1.5px solid var(--border);border-radius:10px;font-weight:800;font-size:0.95rem;cursor:pointer;background:var(--bg-light);font-family:inherit;transition:all 0.15s;"
                onmouseover="this.style.background='var(--primary)';this.style.color='white';this.style.borderColor='var(--primary)'"
                onmouseout="this.style.background='var(--bg-light)';this.style.color='';this.style.borderColor='var(--border)'">${n}</button>`).join('')}
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button onclick="const q=document.getElementById('sell-qty');q.value=Math.max(1,+q.value-1);CanteenModule._updateSellTotal(${item.salePrice})"
              style="width:38px;height:38px;border:1.5px solid var(--border);border-radius:10px;background:var(--bg-light);font-size:1.2rem;cursor:pointer;font-weight:800;">−</button>
            <input id="sell-qty" type="number" value="1" min="1" max="999"
              oninput="CanteenModule._updateSellTotal(${item.salePrice})"
              style="flex:1;padding:0.6rem;border:1.5px solid var(--border);border-radius:10px;text-align:center;font-size:1.1rem;font-weight:800;font-family:inherit;outline:none;">
            <button onclick="const q=document.getElementById('sell-qty');q.value=+q.value+1;CanteenModule._updateSellTotal(${item.salePrice})"
              style="width:38px;height:38px;border:1.5px solid var(--border);border-radius:10px;background:var(--bg-light);font-size:1.2rem;cursor:pointer;font-weight:800;">+</button>
          </div>
        </div>

        <!-- الإجمالي -->
        <div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1.5px solid #86efac;border-radius:14px;padding:1rem;text-align:center;margin-bottom:1.4rem;">
          <div style="font-size:0.82rem;color:#16a34a;font-weight:700;margin-bottom:4px;">💰 إجمالي الفاتورة</div>
          <div id="sell-total" style="font-size:2rem;font-weight:800;color:#15803d;">${fmt(item.salePrice)} ج</div>
          <div id="sell-profit-preview" style="font-size:0.75rem;color:#16a34a;margin-top:3px;">
            ربح: ${fmt(item.salePrice - (item.costPrice||0))} ج
          </div>
        </div>

        <!-- أزرار -->
        <div style="display:flex;gap:0.75rem;">
          <button onclick="CanteenModule.confirmSale('${item.id}')"
            style="flex:1;padding:0.9rem;border:none;border-radius:12px;background:linear-gradient(135deg,#16a34a,#15803d);color:white;font-size:1rem;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 4px 12px rgba(22,163,74,0.3);">
            <i class="fas fa-check"></i> تأكيد البيع
          </button>
          <button onclick="document.getElementById('canteen-sell-modal').remove()"
            style="padding:0.9rem 1.1rem;border:none;border-radius:12px;background:var(--bg-light);cursor:pointer;font-family:inherit;">
            إلغاء
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target===modal) modal.remove(); });
    setTimeout(() => document.getElementById('sell-qty')?.focus(), 100);
  }

  function _updateSellTotal(unitPrice) {
    const qty  = Math.max(1, parseInt(document.getElementById('sell-qty')?.value)||1);
    const total = qty * unitPrice;
    const item  = items.find(i => i.salePrice == unitPrice) || { costPrice: 0 };
    const profit = qty * (unitPrice - (item.costPrice||0));
    const el = document.getElementById('sell-total');
    const ep = document.getElementById('sell-profit-preview');
    if (el) el.textContent = fmt(total) + ' ج';
    if (ep) ep.textContent = 'ربح: ' + fmt(profit) + ' ج';
  }

  async function confirmSale(itemId) {
    const item = items.find(i => String(i.id) === String(itemId));
    if (!item) return;
    const qty = Math.max(1, parseInt(document.getElementById('sell-qty')?.value)||1);
    const unitPrice  = item.salePrice;
    const totalPrice = qty * unitPrice;
    const profit     = qty * (unitPrice - (item.costPrice||0));

    const sale = {
      id: Date.now() + Math.random(),
      itemId: item.id,
      itemName: item.name,
      itemEmoji: item.emoji || '📦',
      qty,
      unitPrice,
      totalPrice,
      profit,
      date: todayStr(),
      createdAt: new Date().toISOString()
    };

    sales.push(sale);
    await saveSale(sale);

    _removeModal('canteen-sell-modal');
    notify(`✅ تم بيع ${qty} × ${item.name} بـ ${fmt(totalPrice)} ج`, 'success');

    // تحديث الشاشة
    renderView();
  }

  async function _deleteSale(saleId) {
    if (!confirm('حذف هذه العملية من السجل؟')) return;
    sales = sales.filter(s => String(s.id) !== String(saleId));
    await StorageEngine.delete('canteenSales', +saleId || saleId);
    renderView();
  }

  /* ══════════════════════════════════════════════════════════
     شاشة الأصناف
  ══════════════════════════════════════════════════════════ */
  function renderItems(el) {
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;flex-wrap:wrap;gap:0.75rem;">
        <div style="font-weight:800;color:var(--text-main);font-size:0.95rem;">
          <i class="fas fa-boxes" style="color:var(--primary);margin-left:5px;"></i>
          قائمة الأصناف (${items.length} صنف)
        </div>
        <button onclick="CanteenModule.openItemModal()"
          style="padding:0.6rem 1.3rem;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.88rem;">
          <i class="fas fa-plus"></i> صنف جديد
        </button>
      </div>

      ${items.length === 0 ?
        `<div style="text-align:center;padding:4rem;color:var(--text-muted);">
           <div style="font-size:3rem;margin-bottom:1rem;">📦</div>
           <p style="font-weight:700;">لا توجد أصناف بعد</p>
           <button onclick="CanteenModule.openItemModal()"
             style="margin-top:1rem;padding:0.65rem 1.5rem;background:var(--primary);color:white;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-family:inherit;">
             <i class="fas fa-plus"></i> أضف أول صنف
           </button>
         </div>` :
        `<div style="display:flex;flex-direction:column;gap:0.6rem;">
          ${items.map(item => _itemRow(item)).join('')}
        </div>`
      }`;
  }

  function _itemRow(item) {
    const itemSales = sales.filter(s => String(s.itemId) === String(item.id));
    const totalSold = itemSales.reduce((a,s)=>a+s.qty,0);
    const totalRev  = itemSales.reduce((a,s)=>a+s.totalPrice,0);
    const inactive  = item.isActive === false;

    return `
      <div style="display:flex;align-items:center;gap:0.9rem;padding:0.85rem 1rem;
                  background:var(--bg-white);border-radius:14px;border:1.5px solid var(--border);
                  opacity:${inactive?0.55:1};">
        <div style="font-size:2rem;width:44px;text-align:center;flex-shrink:0;">${item.emoji||'📦'}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:800;font-size:0.92rem;color:var(--text-main);">${_esc(item.name)}
            ${inactive?'<span style="background:#f1f5f9;color:#94a3b8;border-radius:6px;padding:1px 7px;font-size:0.7rem;margin-right:5px;">متوقف</span>':''}
          </div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">${_esc(item.category||'')}</div>
        </div>
        <div style="text-align:center;min-width:70px;">
          <div style="font-size:0.68rem;color:var(--text-muted);">التكلفة</div>
          <div style="font-weight:700;color:#ef4444;font-size:0.88rem;">${fmt(item.costPrice)} ج</div>
        </div>
        <div style="text-align:center;min-width:70px;">
          <div style="font-size:0.68rem;color:var(--text-muted);">البيع</div>
          <div style="font-weight:800;color:#16a34a;font-size:0.95rem;">${fmt(item.salePrice)} ج</div>
        </div>
        <div style="text-align:center;min-width:65px;">
          <div style="font-size:0.68rem;color:var(--text-muted);">مبيعات</div>
          <div style="font-weight:700;color:var(--primary);font-size:0.85rem;">${totalSold} قطعة</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;">
          <button onclick="CanteenModule.openItemModal('${item.id}')"
            style="padding:5px 10px;border:none;background:var(--primary);color:white;border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="CanteenModule.toggleItem('${item.id}')"
            title="${inactive?'تفعيل':'إيقاف'}"
            style="padding:5px 10px;border:none;background:${inactive?'#dcfce7':'#fef2f2'};color:${inactive?'#16a34a':'#ef4444'};border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-${inactive?'play':'pause'}"></i>
          </button>
          <button onclick="CanteenModule.deleteItem('${item.id}')"
            style="padding:5px 10px;border:none;background:#fef2f2;color:#ef4444;border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════
     مودال إضافة / تعديل صنف
  ══════════════════════════════════════════════════════════ */
  function openItemModal(itemId = null) {
    editingItemId = itemId;
    const item = itemId ? items.find(i => String(i.id) === String(itemId)) : null;

    _removeModal('canteen-item-modal');
    const modal = document.createElement('div');
    modal.id = 'canteen-item-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
    modal.innerHTML = `
      <div style="background:var(--bg-white,#fff);border-radius:22px;padding:1.8rem;max-width:480px;width:96%;max-height:90vh;overflow-y:auto;direction:rtl;font-family:inherit;box-shadow:0 24px 60px rgba(0,0,0,0.28);">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
          <h3 style="margin:0;font-size:1.05rem;font-weight:800;color:var(--primary);">
            <i class="fas fa-${itemId?'edit':'plus-circle'}"></i>
            ${itemId ? 'تعديل الصنف' : 'إضافة صنف جديد'}
          </h3>
          <button onclick="document.getElementById('canteen-item-modal').remove()"
            style="background:var(--bg-light);border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- الأيقونة -->
        <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:8px;">أيقونة الصنف</label>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:1rem;padding:0.75rem;background:var(--bg-light);border-radius:12px;">
          ${ITEM_EMOJIS.map(e => `
            <button onclick="document.querySelectorAll('.emoji-btn').forEach(b=>b.style.background='');this.style.background='var(--primary)20';window._selEmoji='${e}'"
              class="emoji-btn"
              style="font-size:1.5rem;background:${(item?.emoji||'🍟')===e?'var(--primary)20':'transparent'};border:none;border-radius:8px;padding:4px 6px;cursor:pointer;transition:all 0.12s;">${e}</button>`).join('')}
        </div>

        <!-- الاسم -->
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">اسم الصنف *</label>
          <input id="item-name" type="text" value="${_esc(item?.name||'')}" placeholder="مثال: شيبسي، كولا، ساندوتش ..."
            style="width:100%;padding:0.75rem;border:1.5px solid var(--border);border-radius:10px;font-family:inherit;font-size:0.95rem;box-sizing:border-box;outline:none;">
        </div>

        <!-- الفئة -->
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">الفئة</label>
          <select id="item-category"
            style="width:100%;padding:0.75rem;border:1.5px solid var(--border);border-radius:10px;font-family:inherit;font-size:0.9rem;background:var(--bg-white);">
            ${CATEGORIES.map(c=>`<option value="${c}" ${(item?.category||'أكل خفيف')===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>

        <!-- الأسعار -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1.4rem;">
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">💸 سعر التكلفة (ج)</label>
            <input id="item-cost" type="number" min="0" step="0.5" value="${item?.costPrice||''}" placeholder="0"
              oninput="CanteenModule._previewProfit()"
              style="width:100%;padding:0.75rem;border:1.5px solid var(--border);border-radius:10px;font-family:inherit;font-size:1rem;box-sizing:border-box;outline:none;">
          </div>
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">💰 سعر البيع (ج) *</label>
            <input id="item-sale" type="number" min="0" step="0.5" value="${item?.salePrice||''}" placeholder="0"
              oninput="CanteenModule._previewProfit()"
              style="width:100%;padding:0.75rem;border:1.5px solid var(--border);border-radius:10px;font-family:inherit;font-size:1rem;box-sizing:border-box;outline:none;">
          </div>
        </div>

        <!-- معاينة الربح -->
        <div id="profit-preview" style="background:var(--bg-light);border-radius:10px;padding:0.7rem 1rem;margin-bottom:1.4rem;font-size:0.85rem;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:var(--text-muted);">ربح القطعة الواحدة:</span>
          <span id="profit-val" style="font-weight:800;color:#16a34a;">---</span>
        </div>

        <div style="display:flex;gap:0.75rem;">
          <button onclick="CanteenModule.saveItemModal()"
            style="flex:1;padding:0.85rem;border:none;border-radius:12px;background:var(--primary);color:white;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.9rem;">
            <i class="fas fa-save"></i> ${itemId ? 'حفظ التعديل' : 'إضافة الصنف'}
          </button>
          <button onclick="document.getElementById('canteen-item-modal').remove()"
            style="padding:0.85rem 1rem;border:none;border-radius:12px;background:var(--bg-light);cursor:pointer;font-family:inherit;">
            إلغاء
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target===modal) modal.remove(); });
    window._selEmoji = item?.emoji || '🍟';
    setTimeout(() => {
      document.getElementById('item-name')?.focus();
      _previewProfit();
    }, 80);
  }

  function _previewProfit() {
    const cost = parseFloat(document.getElementById('item-cost')?.value)||0;
    const sale = parseFloat(document.getElementById('item-sale')?.value)||0;
    const el   = document.getElementById('profit-val');
    if (!el) return;
    const profit = sale - cost;
    el.textContent = fmt(profit) + ' ج';
    el.style.color = profit >= 0 ? '#16a34a' : '#ef4444';
  }

  async function saveItemModal() {
    const name      = document.getElementById('item-name')?.value.trim();
    const category  = document.getElementById('item-category')?.value || 'أكل خفيف';
    const costPrice = parseFloat(document.getElementById('item-cost')?.value)||0;
    const salePrice = parseFloat(document.getElementById('item-sale')?.value);
    const emoji     = window._selEmoji || '📦';

    if (!name)              return notify('يرجى كتابة اسم الصنف', 'error');
    if (isNaN(salePrice) || salePrice < 0) return notify('يرجى إدخال سعر بيع صحيح', 'error');

    if (editingItemId) {
      const item = items.find(i => String(i.id) === String(editingItemId));
      if (!item) return;
      Object.assign(item, { name, category, costPrice, salePrice, emoji });
      await saveItem(item);
      notify('✅ تم تحديث الصنف');
    } else {
      const item = {
        id: Date.now(),
        name, category, costPrice, salePrice, emoji,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      items.push(item);
      await saveItem(item);
      notify('✅ تمت إضافة الصنف');
    }

    _removeModal('canteen-item-modal');
    renderView();
  }

  async function toggleItem(itemId) {
    const item = items.find(i => String(i.id) === String(itemId));
    if (!item) return;
    item.isActive = item.isActive === false ? true : false;
    await saveItem(item);
    renderView();
  }

  async function deleteItem(itemId) {
    const item = items.find(i => String(i.id) === String(itemId));
    if (!item) return;
    const count = sales.filter(s => String(s.itemId) === String(itemId)).length;
    const msg = count
      ? `حذف "${item.name}"؟ لديه ${count} عملية بيع مسجّلة. البيانات التاريخية ستظل موجودة.`
      : `حذف "${item.name}"؟`;
    if (!confirm(msg)) return;
    items = items.filter(i => String(i.id) !== String(itemId));
    await deleteItemDB(+itemId || itemId);
    notify('تم حذف الصنف');
    renderView();
  }

  /* ══════════════════════════════════════════════════════════
     شاشة التقارير
  ══════════════════════════════════════════════════════════ */
  function renderReports(el) {
    // احسب الفترات
    const today      = todayStr();
    const thisWeek   = _weekStart();
    const thisMonth  = today.slice(0,7);

    const totalRevenue  = sales.reduce((a,s)=>a+s.totalPrice,0);
    const totalProfit   = sales.reduce((a,s)=>a+s.profit,0);
    const totalQty      = sales.reduce((a,s)=>a+s.qty,0);
    const totalSalesN   = sales.length;

    const todaySalesArr = sales.filter(s=>s.date===today);
    const weekSales     = sales.filter(s=>s.date>=thisWeek);
    const monthSales    = sales.filter(s=>(s.date||'').startsWith(thisMonth));

    // أفضل الأصناف
    const byItem = {};
    sales.forEach(s=>{
      if (!byItem[s.itemName]) byItem[s.itemName] = {qty:0, revenue:0, profit:0, emoji:s.itemEmoji||'📦'};
      byItem[s.itemName].qty     += s.qty;
      byItem[s.itemName].revenue += s.totalPrice;
      byItem[s.itemName].profit  += s.profit;
    });
    const topByQty    = Object.entries(byItem).sort((a,b)=>b[1].qty-a[1].qty).slice(0,5);
    const topByProfit = Object.entries(byItem).sort((a,b)=>b[1].profit-a[1].profit).slice(0,5);

    // آخر 30 يوم تفصيلي
    const last30 = {};
    for (let i=0;i<30;i++){
      const d = new Date(); d.setDate(d.getDate()-i);
      const k = d.toISOString().split('T')[0];
      last30[k] = {revenue:0, profit:0, qty:0};
    }
    sales.forEach(s=>{
      if (last30[s.date]) {
        last30[s.date].revenue += s.totalPrice;
        last30[s.date].profit  += s.profit;
        last30[s.date].qty     += s.qty;
      }
    });
    const last30Arr = Object.entries(last30).sort((a,b)=>a[0]<b[0]?-1:1);

    el.innerHTML = `
      <!-- إجمالي كل الوقت -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-bottom:1.5rem;">
        ${_statCard('💰','إجمالي الإيرادات', fmt(totalRevenue)+' ج', '#16a34a')}
        ${_statCard('📈','إجمالي الأرباح',   fmt(totalProfit) +' ج', '#0ea5e9')}
        ${_statCard('🛍️','إجمالي المبيعات', totalSalesN+' فاتورة',  '#f59e0b')}
        ${_statCard('📦','قطع مباعة',        fmt(totalQty)+' قطعة',  '#8b5cf6')}
      </div>

      <!-- مقارنة الفترات -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem;">
        ${_periodCard('📅 اليوم',   todaySalesArr)}
        ${_periodCard('📆 هذا الأسبوع', weekSales)}
        ${_periodCard('🗓️ هذا الشهر',  monthSales)}
      </div>

      <!-- أكثر الأصناف مبيعاً -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem;">
        <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;border:1.5px solid var(--border);">
          <div style="font-weight:800;font-size:0.88rem;margin-bottom:1rem;color:var(--text-main);">🏆 الأكثر مبيعاً (كمية)</div>
          ${topByQty.length===0?'<p style="color:var(--text-muted);text-align:center;">لا توجد بيانات</p>':
            topByQty.map(([name,d],i)=>`
              <div style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0;border-bottom:1px solid var(--bg-light);">
                <span style="font-size:1rem;">${['🥇','🥈','🥉','4️⃣','5️⃣'][i]}</span>
                <span style="font-size:1.1rem;">${d.emoji}</span>
                <span style="flex:1;font-size:0.85rem;font-weight:700;">${_esc(name)}</span>
                <span style="font-weight:800;color:var(--primary);font-size:0.88rem;">${d.qty} قطعة</span>
              </div>`).join('')
          }
        </div>
        <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;border:1.5px solid var(--border);">
          <div style="font-weight:800;font-size:0.88rem;margin-bottom:1rem;color:var(--text-main);">💸 الأعلى ربحاً</div>
          ${topByProfit.length===0?'<p style="color:var(--text-muted);text-align:center;">لا توجد بيانات</p>':
            topByProfit.map(([name,d],i)=>`
              <div style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0;border-bottom:1px solid var(--bg-light);">
                <span style="font-size:1rem;">${['🥇','🥈','🥉','4️⃣','5️⃣'][i]}</span>
                <span style="font-size:1.1rem;">${d.emoji}</span>
                <span style="flex:1;font-size:0.85rem;font-weight:700;">${_esc(name)}</span>
                <span style="font-weight:800;color:#16a34a;font-size:0.88rem;">${fmt(d.profit)} ج</span>
              </div>`).join('')
          }
        </div>
      </div>

      <!-- جدول آخر 30 يوم -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;border:1.5px solid var(--border);overflow-x:auto;">
        <div style="font-weight:800;font-size:0.88rem;margin-bottom:1rem;color:var(--text-main);">📊 آخر 30 يوم (تفصيلي)</div>
        <table style="width:100%;border-collapse:collapse;min-width:500px;font-size:0.82rem;">
          <thead>
            <tr style="background:var(--bg-light);">
              <th style="padding:0.6rem 0.8rem;text-align:right;font-weight:800;color:var(--text-muted);">التاريخ</th>
              <th style="padding:0.6rem 0.8rem;text-align:center;font-weight:800;color:var(--text-muted);">الإيراد</th>
              <th style="padding:0.6rem 0.8rem;text-align:center;font-weight:800;color:var(--text-muted);">الربح</th>
              <th style="padding:0.6rem 0.8rem;text-align:center;font-weight:800;color:var(--text-muted);">الكمية</th>
            </tr>
          </thead>
          <tbody>
            ${last30Arr.reverse().map(([date,d])=> {
              const isToday = date === today;
              return `
                <tr style="border-bottom:1px solid var(--bg-light);${isToday?'background:#f0fdf4;font-weight:700;':''}">
                  <td style="padding:0.55rem 0.8rem;">${new Date(date).toLocaleDateString('ar-EG',{weekday:'short',day:'numeric',month:'short'})}${isToday?' 🔵':''}</td>
                  <td style="padding:0.55rem;text-align:center;color:${d.revenue>0?'#16a34a':'var(--text-muted)'};">${d.revenue>0?fmt(d.revenue)+' ج':'—'}</td>
                  <td style="padding:0.55rem;text-align:center;color:${d.profit>0?'#0ea5e9':'var(--text-muted)'};">${d.profit>0?fmt(d.profit)+' ج':'—'}</td>
                  <td style="padding:0.55rem;text-align:center;color:${d.qty>0?'var(--primary)':'var(--text-muted)'};">${d.qty>0?d.qty+' ق':'—'}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function _periodCard(label, arr) {
    const rev  = arr.reduce((a,s)=>a+s.totalPrice,0);
    const prof = arr.reduce((a,s)=>a+s.profit,0);
    const qty  = arr.reduce((a,s)=>a+s.qty,0);
    return `
      <div style="background:var(--bg-white);border-radius:14px;padding:1.1rem 1.2rem;border:1.5px solid var(--border);">
        <div style="font-weight:800;font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem;">${label}</div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;">
            <span>💰 إيراد</span><b style="color:#16a34a;">${fmt(rev)} ج</b>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;">
            <span>📈 ربح</span><b style="color:#0ea5e9;">${fmt(prof)} ج</b>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;">
            <span>🛍️ قطع</span><b style="color:var(--primary);">${qty}</b>
          </div>
        </div>
      </div>`;
  }

  function _weekStart() {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().split('T')[0];
  }

  /* ══════════════════════════════════════════════════════════
     مساعدات
  ══════════════════════════════════════════════════════════ */
  function _esc(str) {
    return String(str||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function _removeModal(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  /* ══════════════════════════════════════════════════════════
     حقن Nav + Section
  ══════════════════════════════════════════════════════════ */
  function ensureNav() {
    if (document.getElementById('nav-canteen')) return;
    const nav = document.querySelector('.nav-links');
    if (!nav) return;

    const item = document.createElement('li');
    item.className = 'nav-item';
    item.innerHTML = `
      <a href="#" class="nav-link" id="nav-canteen" onclick="showSection('canteen', this)">
        <i class="fas fa-store" style="color:#f59e0b;"></i>
        <span>الكانتين</span>
      </a>`;

    // قبل الإعدادات أو آخر القائمة
    const settingsItem = document.getElementById('nav-settings')?.closest('.nav-item');
    nav.insertBefore(item, settingsItem || nav.lastElementChild);
  }

  function ensureSection() {
    if (document.getElementById('canteen-section')) return;
    const main = document.querySelector('.main-content');
    if (!main) return;

    const section = document.createElement('section');
    section.id = 'canteen-section';
    section.className = 'fade-in';
    section.style.display = 'none';
    section.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1.4rem;">
        <div>
          <h2 style="margin:0;font-size:1.25rem;font-weight:800;color:var(--text-main);">
            🛒 حساب الكانتين
          </h2>
          <p style="margin:4px 0 0;font-size:0.83rem;color:var(--text-muted);">تسجيل المبيعات وتتبع الأرباح</p>
        </div>
      </div>
      <div id="canteen-content"></div>`;

    main.appendChild(section);
  }

  /* ══════════════════════════════════════════════════════════
     API عام
  ══════════════════════════════════════════════════════════ */
  async function init() {
    await loadData();
    render();
  }

  window.CanteenModule = {
    init,
    ensureUI() { ensureNav(); ensureSection(); },
    openSellModal,
    confirmSale,
    openItemModal,
    saveItemModal,
    toggleItem,
    deleteItem,
    _setView(v) { activeView = v; renderView(); },
    _updateSellTotal,
    _previewProfit,
    _deleteSale,
  };

  document.addEventListener('DOMContentLoaded', () => {
    CanteenModule.ensureUI();
    console.log('[canteen.js] ✅ نظام الكانتين جاهز');
  });

})();
