(() => {
  const root = document.querySelector('.concept-lab');
  if (!root) return;

  const concepts = {
    food: {
      count: '01 / 03', sector: 'FOOD / PRODUCT', name: 'من الطعم إلى الذاكرة.',
      reason: 'بدل تعداد المكونات، نحكي عن اللحظة التي تخلي التجربة تنحفظ بالبال.',
      format: 'حملة قصيرة + منشورات متسلسلة', code: 'F-001',
      overline: 'A GOOD THING TAKES TIME', artTitle: 'الطعم\nإله حكاية.',
      sticker: 'MADE TO\nREMEMBER', footer: 'SLOW MOMENTS / BIG FLAVOUR',
      discipline: 'CAMPAIGN LANGUAGE'
    },
    care: {
      count: '02 / 03', sector: 'SERVICE / CARE', name: 'الثقة تبدي من الوضوح.',
      reason: 'نرتب المعلومة ونقلل الوعود حتى الشخص يفهم الخدمة وخطوتها الجاية.',
      format: 'رسالة تعريف + سلسلة توضيح', code: 'C-002',
      overline: 'CLEAR INFORMATION / CALM DESIGN', artTitle: 'الراحة\nتبدي من\nالفهم.',
      sticker: 'CARE IN\nEVERY DETAIL', footer: 'LESS PROMISE / MORE CLARITY',
      discipline: 'SERVICE LANGUAGE'
    },
    retail: {
      count: '03 / 03', sector: 'RETAIL / OFFER', name: 'مو خصم وبس. اختيار أذكى.',
      reason: 'نربط تفاصيل العرض بسبب مقنع للشراء، حتى يصير المحتوى فكرة مو مجرد سعر.',
      format: 'زاوية حملة + مجموعة منشورات', code: 'R-003',
      overline: 'THE VALUE BEHIND THE PRICE', artTitle: 'مو خصم.\nاختيار\nأذكى.',
      sticker: 'THE\nGOOD PICK', footer: 'VALUE / NOT JUST A NUMBER',
      discipline: 'OFFER CAMPAIGN'
    }
  };

  const targets = {
    count: '#conceptCounter', sector: '#conceptSector', name: '#conceptName',
    reason: '#conceptReason', format: '#conceptFormat', code: '#conceptCode',
    overline: '#conceptOverline', title: '#conceptArtTitle', sticker: '#conceptSticker',
    footer: '#conceptArtFooter', discipline: '#conceptDiscipline'
  };
  const nodes = Object.fromEntries(
    Object.entries(targets).map(([key, selector]) => [key, root.querySelector(selector)])
  );
  const buttons = [...root.querySelectorAll('[data-concept-choice]')];

  function select(key) {
    const item = concepts[key];
    if (!item) return;
    root.dataset.concept = key;
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.conceptChoice === key));
    });
    Object.entries(nodes).forEach(([name, node]) => {
      if (node) node.textContent = item[name];
    });
  }

  buttons.forEach((button) => {
    button.addEventListener('click', () => select(button.dataset.conceptChoice));
  });
  select('food');
})();
