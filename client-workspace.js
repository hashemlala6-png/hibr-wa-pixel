(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const money = (value) => {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('ar-IQ') + ' د.ع' : '—';
  };
  const date = (value) => {
    if (!value) return 'غير محدد';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? esc(value) : parsed.toLocaleDateString('ar-IQ', {year:'numeric',month:'short',day:'numeric'});
  };
  const statusMap = {
    planned: ['مخطط', ''], active: ['قيد التنفيذ', ''], in_progress: ['قيد التنفيذ', ''],
    review: ['مرحلة المراجعة', 'is-review'], completed: ['مكتمل', 'is-done'],
    done: ['مكتمل', 'is-done'], paused: ['متوقف', 'is-paused'],
    new: ['جديد', 'is-wait'], reviewing: ['قيد المراجعة', 'is-wait'],
    quoted: ['تم إرسال عرض', ''], approved: ['تمت الموافقة', 'is-good'],
    pending: ['بانتظار الإجراء', 'is-wait'], pending_signature: ['بانتظار التوقيع', 'is-wait'],
    sent: ['مرسل للمراجعة', 'is-wait'], awaiting_signature: ['بانتظار التوقيع', 'is-wait'],
    signed: ['تم التوقيع', 'is-good'], cancelled: ['ملغي', 'is-paused'],
    paid: ['مدفوعة', 'is-good'], unpaid: ['غير مدفوعة', 'is-wait'],
    overdue: ['متأخرة', 'is-wait'], delivered: ['تم التسليم', 'is-good'],
    ready: ['جاهز', 'is-good']
  };
  const label = (value) => statusMap[String(value || '').toLowerCase()] || ['قيد التحديث', ''];
  const tag = (value) => {
    const [text, cls] = label(value);
    return '<span class="cw-tag ' + cls + '">' + text + '</span>';
  };
  const safeUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  };
  const get = async (url) => {
    const response = await fetch(url, {credentials:'include',cache:'no-store',headers:{'Accept':'application/json'}});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'تعذر تحميل البيانات.');
      error.status = response.status;
      throw error;
    }
    return data;
  };
  const empty = (message) => '<div class="cw-empty">' + esc(message) + '</div>';
  const itemRow = (title, meta, status) => '<div class="cw-item"><div class="cw-item-main"><strong>' + esc(title || 'عنصر بلا عنوان') + '</strong>' +
    (meta ? '<small>' + esc(meta) + '</small>' : '') + '</div>' + (status ? tag(status) : '') + '</div>';

  function renderTasks(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) return empty('لا توجد مهام مسجلة لهذا المشروع حالياً.');
    return '<div class="cw-item-list">' + tasks.map((task) => itemRow(
      task.title, task.dueDate ? 'موعد المهمة: ' + date(task.dueDate) : '', task.status
    )).join('') + '</div>';
  }

  function renderDeliveries(deliveries) {
    if (!Array.isArray(deliveries) || !deliveries.length) return empty('لا توجد تسليمات مسجلة لهذا المشروع حتى الآن.');
    return '<div class="cw-item-list">' + deliveries.map((delivery) => {
      const url = safeUrl(delivery.url);
      return '<div class="cw-item"><div class="cw-item-main"><strong>' + esc(delivery.title || 'تسليم مشروع') + '</strong>' +
        (delivery.note ? '<small>' + esc(delivery.note) + '</small>' : '') +
        (delivery.createdAt ? '<small>تاريخ الإضافة: ' + date(delivery.createdAt) + '</small>' : '') +
        (url ? '<a class="cw-delivery-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">فتح التسليم <b>↗</b></a>' : '') +
        '</div>' + tag(delivery.status) + '</div>';
    }).join('') + '</div>';
  }

  function renderInvoices(invoices) {
    if (!Array.isArray(invoices) || !invoices.length) return empty('لا توجد فواتير مرتبطة بهذا المشروع حالياً.');
    return '<div class="cw-invoice-list">' + invoices.map((invoice) => {
      const title = invoice.number ? 'فاتورة ' + invoice.number : 'فاتورة المشروع';
      const when = invoice.dueDate ? 'الاستحقاق: ' + date(invoice.dueDate) : 'تاريخ الإضافة: ' + date(invoice.createdAt);
      return '<div class="cw-invoice"><div class="cw-invoice-head"><strong>' + esc(title) + '</strong>' + tag(invoice.status) + '</div>' +
        '<div class="cw-invoice-meta"><small>' + when + '</small><b>' + money(invoice.total) + '</b></div></div>';
    }).join('') + '</div>';
  }

  function renderResult(result) {
    if (!result) return empty('لا توجد مخرجات معتمدة للعرض حالياً.');
    const deliverables = Array.isArray(result.deliverables) ? result.deliverables : [];
    const list = deliverables.map((item) => {
      if (typeof item === 'string') return '<li>' + esc(item) + '</li>';
      if (item && typeof item === 'object') {
        const name = item.title || item.name || item.label || item.description;
        return name ? '<li>' + esc(name) + '</li>' : '';
      }
      return '';
    }).join('');
    return '<div class="cw-result-note"><strong>' + esc(result.promise || 'مخرجات المشروع المعتمدة') + '</strong>' +
      (list ? '<ul>' + list + '</ul>' : '') +
      (result.handoffMessage ? '<p>' + esc(result.handoffMessage) + '</p>' : '') + '</div>';
  }

  function renderProject(project, index) {
    const amount = Number(project.amount || 0);
    const paid = Number(project.paid || 0);
    const remaining = Number(project.remaining ?? Math.max(amount - paid, 0));
    const hasAmount = amount > 0;
    const stage = label(project.status);
    const contracts = Array.isArray(project.contracts) ? project.contracts : [];
    const invoices = Array.isArray(project.invoices) ? project.invoices : [];
    const payments = Array.isArray(project.payments) ? project.payments : [];
    return '<article class="cw-project-card">' +
      '<header class="cw-project-head"><div>' +
       '<div class="cw-project-title-line"><h3>' + esc(project.name || 'مشروع جديد') + '</h3><span class="cw-project-reference">PROJECT / ' + String(index + 1).padStart(2,'0') + '</span></div>' +
       '<div class="cw-project-dates"><span>البداية: ' + date(project.startDate) + '</span><span>التسليم المتوقع: ' + date(project.dueDate) + '</span></div>' +
      '</div><span class="cw-stage ' + stage[1] + '">' + stage[0] + '</span></header>' +
      '<div class="cw-project-finance">' +
       '<div class="cw-finance-cell"><small>قيمة المشروع</small><strong>' + (hasAmount ? money(amount) : 'لم تُحدد بعد') + '</strong></div>' +
       '<div class="cw-finance-cell"><small>المدفوع المسجل</small><strong>' + money(paid) + '</strong></div>' +
       '<div class="cw-finance-cell"><small>المتبقي حسب السجل</small><strong>' + (hasAmount ? money(remaining) : 'يُحدد بعد الاتفاق') + '</strong></div>' +
      '</div>' +
      '<div class="cw-project-content">' +
       '<section class="cw-lane"><div class="cw-lane-heading"><h4>المهام</h4><small>' + (Array.isArray(project.tasks) ? project.tasks.length : 0) + ' TASKS</small></div>' + renderTasks(project.tasks) + '</section>' +
       '<section class="cw-lane"><div class="cw-lane-heading"><h4>التسليمات</h4><small>' + (Array.isArray(project.deliveries) ? project.deliveries.length : 0) + ' FILES</small></div>' + renderDeliveries(project.deliveries) + '</section>' +
       '<section class="cw-lane"><div class="cw-lane-heading"><h4>الفواتير</h4><small>INVOICES</small></div>' + renderInvoices(invoices) + '</section>' +
       '<section class="cw-lane"><div class="cw-lane-heading"><h4>ملخص الاتفاق</h4><small>' + contracts.length + ' RECORDS</small></div>' +
        (contracts.length ? '<div class="cw-item-list">' + contracts.map((c) => itemRow(c.number ? 'عقد رقم ' + c.number : 'اتفاق المشروع', (c.amount ? money(c.amount) + ' · ' : '') + (c.startDate ? date(c.startDate) : '') + (c.dueDate ? ' — ' + date(c.dueDate) : ''), c.status)).join('') + '</div>' : empty('لا يوجد عقد مرتبط بالمشروع بعد.')) +
        (payments.length ? '<div class="cw-payments-note">عدد الدفعات المسجلة: <b>' + payments.length + '</b></div>' : '') +
       '</section>' +
       '<section class="cw-lane cw-lane-result"><div class="cw-lane-heading"><h4>مخرجات معتمدة</h4><small>HANDOFF</small></div>' + renderResult(project.clientResult) + '</section>' +
      '</div></article>';
  }

  function renderProjects(projects) {
    const root = $('projects');
    if (!Array.isArray(projects) || !projects.length) {
      root.innerHTML = '<div class="cw-no-project"><div><small>YOUR FIRST PROJECT</small><h3>مساحتك جاهزة لأول مشروع.</h3><p>بعد اعتماد المشروع وإنشاء ملفه، تظهر هنا المهام والاتفاقات والتسليمات والدفعات.</p><a class="cw-primary" href="order.html">إرسال طلب مشروع جديد <b>↗</b></a></div><span class="cw-no-project-mark">01</span></div>';
      return;
    }
    root.innerHTML = projects.map(renderProject).join('');
  }

  function signable(contract) {
    const allowed = ['pending','pending_signature','sent','awaiting_signature','review'];
    return allowed.includes(String(contract.status || 'pending')) && String(contract.terms || '').trim().length >= 30 &&
      contract.status !== 'signed' && !contract.signedAt;
  }

  function renderContracts(contracts, projects) {
    const root = $('contracts');
    if (!Array.isArray(contracts) || !contracts.length) {
      root.innerHTML = '<div class="cw-card"><h3>لا يوجد عقد جاهز حالياً</h3><p>عند تحديد نطاق المشروع والسعر والمدة، يظهر الاتفاق هنا للمراجعة والتوقيع.</p></div>';
      return;
    }
    const names = new Map((projects || []).map((p) => [p.id, p.name]));
    root.innerHTML = contracts.map((contract) => {
      const title = contract.title || (contract.number ? 'عقد ' + contract.number : 'اتفاق خدمة');
      const isSigned = contract.status === 'signed' || Boolean(contract.signedAt);
      const form = signable(contract) ?
        '<form class="cw-sign-form" data-contract="' + esc(contract.id) + '">' +
         '<label for="sign-name-' + esc(contract.id) + '">الاسم الكامل للتوقيع</label>' +
         '<input id="sign-name-' + esc(contract.id) + '" name="signedName" type="text" autocomplete="name" required minlength="4">' +
         '<label class="cw-sign-agree"><input type="checkbox" name="acceptTerms" required><span>قرأت بنود الاتفاق أعلاه وأوافق عليها وأطلب تسجيل توقيعي الإلكتروني.</span></label>' +
         '<button class="cw-primary" type="submit">أوافق وأوقّع العقد <b>↗</b></button><div class="cw-message" role="status" aria-live="polite"></div>' +
        '</form>' :
        (isSigned ? '<p class="cw-signed-note">تم التوقيع باسم ' + esc(contract.signedName || 'صاحب الحساب') + ' بتاريخ ' + date(contract.signedAt) + '</p>' :
        '<p class="cw-note-muted">التوقيع غير متاح حالياً. إذا كانت هناك بنود قيد الإكمال، ستظهر إمكانية التوقيع بعد تحديثها.</p>');
      return '<article class="cw-card"><div class="cw-card-head"><h3>' + esc(title) + '</h3>' + tag(contract.status) + '</div>' +
        '<p>المشروع: ' + esc(names.get(contract.projectId) || 'مشروع مرتبط بحسابك') + '</p>' +
        '<dl><div><dt>الخدمة</dt><dd>' + esc(contract.service || 'حسب الاتفاق') + '</dd></div><div><dt>القيمة</dt><dd>' + (Number(contract.amount) ? money(contract.amount) : 'حسب ما يُعتمد') + '</dd></div><div><dt>البداية</dt><dd>' + date(contract.startDate) + '</dd></div><div><dt>الاستحقاق</dt><dd>' + date(contract.dueDate) + '</dd></div></dl>' +
        '<div class="cw-contract-terms">' + esc(contract.terms || 'بنود الاتفاق قيد الإعداد من الإدارة.') + '</div>' + form + '</article>';
    }).join('');
    root.querySelectorAll('.cw-sign-form').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        const message = form.querySelector('.cw-message');
        const fullName = form.elements.signedName.value.trim();
        const accepted = form.elements.acceptTerms.checked;
        if (fullName.length < 4 || !accepted) return;
        button.disabled = true;
        message.className = 'cw-message';
        message.textContent = 'جارٍ حفظ التوقيع…';
        try {
          const response = await fetch('/.netlify/functions/client-agreements', {
            method:'POST', credentials:'include',
            headers:{'Content-Type':'application/json','Accept':'application/json'},
            body:JSON.stringify({contractId:form.dataset.contract,signedName:fullName,acceptTerms:accepted})
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'تعذر تسجيل التوقيع.');
          message.className = 'cw-message is-ok';
          message.textContent = 'تم تسجيل التوقيع. جارٍ تحديث حالة العقد…';
          window.setTimeout(() => window.location.reload(), 800);
        } catch (error) {
          message.className = 'cw-message is-error';
          message.textContent = error.message || 'تعذر تسجيل التوقيع.';
          button.disabled = false;
        }
      });
    });
  }

  function renderSubscriptions(items, projects) {
    const root = $('subscriptions');
    if (!Array.isArray(items) || !items.length) {
      root.innerHTML = '<div class="cw-card"><h3>لا يوجد اشتراك مسجل</h3><p>إذا كان مشروعك يتضمن اشتراكاً، ستظهر تفاصيله هنا بعد اعتماده من الإدارة.</p></div>';
      return;
    }
    const names = new Map((projects || []).map((p) => [p.id, p.name]));
    root.innerHTML = items.map((item) => '<article class="cw-card"><div class="cw-card-head"><h3>' + esc(item.name) + '</h3>' + tag(item.status) + '</div>' +
      '<p>' + esc(item.description || item.service || 'اشتراك مرتبط بأحد مشاريعك') + '</p>' +
      '<dl><div><dt>القيمة</dt><dd>' + money(item.amount) + '</dd></div><div><dt>الدورة</dt><dd>' + esc(item.period || 'حسب الاتفاق') + '</dd></div>' +
      '<div><dt>بداية الاشتراك</dt><dd>' + date(item.startDate) + '</dd></div><div><dt>التجديد القادم</dt><dd>' + date(item.nextBillingDate) + '</dd></div></dl>' +
      '<p>المشروع: ' + esc(names.get(item.projectId) || 'مرتبط بحسابك') + '</p></article>').join('');
  }

  function renderOrders(orders) {
    const root = $('orders');
    const list = Array.isArray(orders) ? orders : [];
    $('count').textContent = list.length.toLocaleString('ar-IQ');
    if (!list.length) {
      root.innerHTML = empty('ما عندك طلبات مسجلة بعد. عند إرسال طلب جديد سيظهر هنا تاريخه وحالته.');
      return;
    }
    root.innerHTML = list.map((order, index) => '<article class="cw-order"><span class="cw-order-number">' + String(index + 1).padStart(2,'0') + '</span>' +
      '<div><h3>' + esc(order.service || 'طلب مشروع') + '</h3><p>' + esc(order.details || 'لا توجد تفاصيل إضافية.') + '</p>' +
      '<small>' + date(order.createdAt) + (order.budget ? ' · الميزانية: ' + esc(order.budget) : '') + (order.timeline ? ' · المدة المطلوبة: ' + esc(order.timeline) : '') + '</small></div>' +
      tag(order.status) + '</article>').join('');
  }

  function renderProfile(profile) {
    const p = profile || {};
    const rows = [['الاسم',p.name],['البريد الإلكتروني',p.email],['واتساب',p.whatsapp],['تاريخ إنشاء الحساب',date(p.createdAt)],['آخر دخول',date(p.lastLoginAt)]];
    $('profile').innerHTML = rows.map(([title,value]) => '<div class="cw-profile-item"><small>' + title + '</small><strong>' + esc(value || '—') + '</strong></div>').join('');
  }

  function renderKpis(projects, orders) {
    const list = Array.isArray(projects) ? projects : [];
    const tasks = list.flatMap((p) => Array.isArray(p.tasks) ? p.tasks : []);
    const openTasks = tasks.filter((task) => !['completed','done','cancelled'].includes(String(task.status || '').toLowerCase()));
    const deliveries = list.flatMap((p) => Array.isArray(p.deliveries) ? p.deliveries : []);
    const metrics = [
      ['المشاريع',list.length,'ملفات مرتبطة بحسابك'],
      ['المهام المفتوحة',openTasks.length,'مهام غير مكتملة في السجل'],
      ['التسليمات',deliveries.length,'ملفات مسجلة'],
      ['الطلبات',Array.isArray(orders) ? orders.length : 0,'طلبات محفوظة']
    ];
    $('workspaceKpis').innerHTML = metrics.map(([title,value,caption]) => '<div class="cw-stat"><small>' + title + '</small><strong>' + Number(value).toLocaleString('ar-IQ') + '</strong><span>' + caption + '</span></div>').join('');
  }

  function renderSignal(contracts, projects) {
    const pending = (contracts || []).find(signable);
    const review = (projects || []).find((project) => project.status === 'review');
    const title = $('workspaceSignalTitle');
    const text = $('workspaceSignalText');
    const link = $('workspaceSignalLink');
    if (pending) {
      title.textContent = 'أكو اتفاق بانتظار مراجعتك وتوقيعك.';
      text.textContent = 'اقرأ بنود الاتفاق وتأكد من التفاصيل قبل اختيار الموافقة والتوقيع.';
      link.href = '#contracts';
      link.innerHTML = 'مراجعة الاتفاق <span>↘</span>';
    } else if (review) {
      title.textContent = 'أحد مشاريعك بمرحلة المراجعة.';
      text.textContent = 'تظهر حالة المشروع الحالية ضمن ملفه، مع المهام والتسليمات المسجلة.';
      link.href = '#projects';
      link.innerHTML = 'عرض المشروع <span>↘</span>';
    } else {
      title.textContent = 'مساحة مشروعك محدثة حسب السجلات المتاحة.';
      text.textContent = 'هنا تتابع الملفات والطلبات والاتفاقات. أي تحديث جديد يظهر عند تسجيله من فريق حبر وبكسل.';
      link.href = '#projects';
      link.innerHTML = 'عرض المشاريع <span>↘</span>';
    }
  }

  async function boot() {
    try {
      const me = await get('/.netlify/functions/client-auth?action=me');
      if (!me.authenticated) {
        window.location.replace('login.html?next=account');
        return;
      }
      const fallbackClient = me.client || {};
      const results = await Promise.allSettled([
        get('/.netlify/functions/client-agreements'),
        get('/.netlify/functions/client'),
        get('/.netlify/functions/orders')
      ]);
      const agreements = results[0].status === 'fulfilled' ? results[0].value : null;
      const workspace = results[1].status === 'fulfilled' ? results[1].value : null;
      const ordersData = results[2].status === 'fulfilled' ? results[2].value : null;
      const projects = workspace && Array.isArray(workspace.projects) ? workspace.projects : [];
      const contracts = agreements && Array.isArray(agreements.contracts) ? agreements.contracts : [];
      const subscriptions = agreements && Array.isArray(agreements.subscriptions) ? agreements.subscriptions : [];
      const orders = ordersData && Array.isArray(ordersData.orders) ? ordersData.orders : [];

      $('hello').textContent = fallbackClient.name ? 'هلا ' + fallbackClient.name : 'مساحة عملك.';
      $('intro').textContent = 'تابع مشاريعك واتفاقاتك وتسليماتك من مكان واحد.';
      renderSignal(contracts, projects);
      renderKpis(projects, orders);

      if (results[1].status === 'fulfilled') renderProjects(projects);
      else $('projects').innerHTML = '<div class="cw-error-inline">' + esc(results[1].reason.message) + '</div>';

      if (results[0].status === 'fulfilled') {
        renderContracts(contracts, projects);
        renderSubscriptions(subscriptions, projects);
        renderProfile(agreements.profile || fallbackClient);
      } else {
        const message = esc(results[0].reason.message || 'تعذر تحميل الاتفاقات.');
        $('contracts').innerHTML = '<div class="cw-error-inline">' + message + '</div>';
        $('subscriptions').innerHTML = '<div class="cw-error-inline">تعذر تحميل الاشتراكات ضمن الجلسة الحالية.</div>';
        renderProfile(fallbackClient);
      }

      if (results[2].status === 'fulfilled') renderOrders(orders);
      else $('orders').innerHTML = '<div class="cw-error-inline">' + esc(results[2].reason.message) + '</div>';

      if (results.some((result) => result.status === 'rejected')) {
        $('error').textContent = 'بعض بيانات المساحة لم تُحمّل. بقية الأقسام المتاحة ما زالت ظاهرة، ويمكنك تحديث الصفحة للمحاولة مرة أخرى.';
      }
    } catch (error) {
      if (error.status === 401) {
        window.location.replace('login.html?next=account');
        return;
      }
      $('error').textContent = error.message || 'تعذر تحميل مساحة العمل.';
    }
  }

  $('logout').addEventListener('click', async () => {
    const button = $('logout');
    button.disabled = true;
    try {
      await fetch('/.netlify/functions/client-auth?action=logout', {method:'POST',credentials:'include'});
    } finally {
      window.location.href = 'index.html';
    }
  });

  boot();
})();
