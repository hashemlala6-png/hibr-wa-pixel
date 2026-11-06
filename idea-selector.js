(() => {
  const root = document.querySelector('.xp-check');
  if (!root) return;

  const recommendations = {
    content: {
      kicker: 'H&P / MESSAGE FIRST',
      mark: 'ك',
      title: 'نحتاج نرتّب الرسالة قبل ما نزيد المنشورات.',
      description: 'نحدد شنو لازم يعرفه الزبون عن مشروعك، ونصوغ خطة أفكار ونصوص توصل القيمة بوضوح.',
      deliverable: 'نقطة البداية: كتابة المحتوى وخطة الأفكار',
      service: 'content'
    },
    design: {
      kicker: 'H&P / VISUAL FIRST',
      mark: 'ب',
      title: 'نحتاج شكلاً بصرياً يشبه مشروعك.',
      description: 'نختار اتجاهاً بصرياً متناسقاً، ونحوّل الرسالة إلى منشورات واضحة ومقروءة على شاشة الهاتف.',
      deliverable: 'نقطة البداية: التصميم البصري للمنشورات',
      service: 'design'
    },
    bundle: {
      kicker: 'H&P / ONE DIRECTION',
      mark: '+',
      title: 'الكلام والصورة لازم يطلعون من فكرة واحدة.',
      description: 'نربط التخطيط والكتابة والتصميم حتى كل مخرج يوصل الرسالة نفسها بصوت وشكل متناسقين.',
      deliverable: 'نقطة البداية: باقة الكتابة + التصميم',
      service: 'bundle'
    }
  };

  const buttons = [...root.querySelectorAll('[data-signal]')];
  const fields = {
    kicker: root.querySelector('#signalKicker'),
    mark: root.querySelector('#signalMark'),
    title: root.querySelector('#signalTitle'),
    description: root.querySelector('#signalDescription'),
    deliverable: root.querySelector('#signalDeliverable'),
    link: root.querySelector('#signalLink'),
    screen: root.querySelector('#signalOutput')
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const item = recommendations[button.dataset.signal];
      if (!item) return;

      buttons.forEach((choice) => {
        choice.setAttribute('aria-pressed', String(choice === button));
      });

      fields.kicker.textContent = item.kicker;
      fields.mark.textContent = item.mark;
      fields.title.textContent = item.title;
      fields.description.textContent = item.description;
      fields.deliverable.textContent = item.deliverable;
      fields.link.href = 'onboarding.html?service=' + encodeURIComponent(item.service);
      fields.link.dataset.funnel = 'signal_check_' + item.service;
      fields.screen.dataset.selection = item.service;
    });
  });
})();
