'use strict';
/*
 * Обучение при первом входе: затемнение, подсветка нужного элемента,
 * подсказка со стрелкой, кнопки «Назад» / «Далее» / «Пропустить».
 * Показывается один раз для каждого сотрудника; повторить можно из справки.
 */

const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
const tourKey = () => 'masters-tour-done:' + (staffId || 'guest');

/* Шаги. target — CSS-селектор (берётся первый видимый элемент) или функция. */
function tourSteps() {
  const phone = isPhone();
  const steps = [
    { title: 'Добро пожаловать!', text: 'Это журнал посещаемости Мастеров. За минуту покажем, где что находится и как ставить отметки. Листайте кнопкой «Далее».' },
    phone
      ? { target: '.bottom-nav [data-open-picker]', title: 'Раздел и четверть', text: 'Здесь выбираете раздел — начальная школа, классы 5–11 или ОГЭ и ЕГЭ — и четверть.' }
      : { target: '.side-nav', title: 'Разделы журнала', text: 'Слева — разделы: начальная школа, классы 5–11, ОГЭ и ЕГЭ. Ниже — статистика и работа с родителями.' },
    { target: '#groups', title: 'Класс или группа', text: 'Нажмите на нужный класс. Выбранный подсвечен цветом.' },
    { target: '.week-control', title: 'Неделя', text: 'Стрелками листайте недели. Кнопка «Сегодня» возвращает к текущему учебному дню.' },
  ];
  if (phone) {
    steps.push(
      { target: '#day-strip', title: 'День', text: 'Выберите день недели. Зелёная точка под датой — занятие уже подтверждено.' },
      { target: '#day-summary .confirm', title: 'Подтвердите занятие', text: 'Сначала нажмите «Подтвердить» — всем ученикам поставится «П». У подтверждённого дня здесь написано «Проведён».' },
      { target: '.day-row .quick-set', title: 'Отметки', text: 'Для отсутствующего нажмите УП (уважительная причина) или НП (неуважительная). «Ещё» — опоздание, камера и другие замечания.' },
      { target: '.day-row .student-btn', title: 'Карточка ученика', text: 'Нажмите на имя — откроется вся посещаемость ученика и его последние пропуски.' },
      { target: '.bottom-nav [data-view-btn="stats"]', title: 'Статистика', text: 'Посещаемость по классам, предметам и ученикам, зона риска.' },
      { target: '.bottom-nav [data-view-btn="curators"]', title: 'Работа с родителями', text: 'Для кураторов: каждую неделю здесь появляются ученики, с родителями которых стоит поговорить.' },
      { target: '.bottom-nav [data-open-more]', title: 'Ещё', text: 'Тема оформления, выгрузка в Excel, справка и выход. Обучение можно пройти снова через «Как заполнять журнал».' },
    );
  } else {
    steps.push(
      { target: ['#attendance-table thead .confirm:not(.on)', '#attendance-table thead .confirm'], title: 'Подтвердите занятие', text: 'Сначала нажмите «Подтвердить» над датой урока — всем ученикам поставится «П». У подтверждённых дат написано «Проведён».' },
      { target: ['#attendance-table tbody td .mark.present', '#attendance-table tbody td .mark'], title: 'Отметьте отсутствующих', text: 'Нажмите на ячейку ученика и выберите УП (уважительная причина), НП (неуважительная) или замечание. Ошиблись — нажмите «Отменить» во всплывающем сообщении внизу.' },
      { target: '#attendance-table tbody .student-btn', title: 'Карточка ученика', text: 'Нажмите на имя — откроется вся посещаемость ученика, график по неделям и последние пропуски.' },
      { target: '[data-sync]', title: 'Сохранение', text: 'Отметки сохраняются сами. Зелёная точка — всё на сервере, жёлтая — идёт отправка, красная — нет связи (отметки отправятся, когда связь вернётся).' },
      { target: '.side-nav [data-view-btn="stats"]', title: 'Статистика', text: 'Посещаемость по классам, предметам, ученикам и дням недели, зона риска и выгрузка отчёта.' },
      { target: '.side-nav [data-view-btn="curators"]', title: 'Работа с родителями', text: 'Для кураторов: каждую неделю здесь появляются ученики с низкой посещаемостью или частыми замечаниями. Отмечайте, когда поговорили с родителями.' },
      { target: '.side-bottom [data-theme-toggle]', title: 'Светлая и тёмная тема', text: 'Выберите, как удобнее глазам.' },
      { target: '.side-bottom [data-open-help]', title: 'Справка', text: 'Здесь краткая инструкция. Там же можно пройти это обучение ещё раз.' },
    );
  }
  steps.push({ title: 'Готово!', text: 'Можно начинать. Если что-то забудете — откройте «Как заполнять».', last: true });
  return steps;
}

const tour = { steps: [], index: 0, el: null };

/** Первый видимый элемент; target может быть списком селекторов по убыванию предпочтения. */
function visibleTarget(target) {
  if (!target) return null;
  for (const selector of [].concat(target)) {
    const found = [...document.querySelectorAll(selector)].find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    if (found) return found;
  }
  return null;
}

function buildTour() {
  const el = document.createElement('div');
  el.id = 'tour';
  el.innerHTML = `
    <div class="tour-shade"></div>
    <div class="tour-hole"></div>
    <div class="tour-pointer" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 20V5M5.5 11.5L12 5l6.5 6.5"/></svg></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
      <i class="tour-arrow"></i>
      <p class="tour-count"></p>
      <h3 id="tour-title"></h3>
      <p id="tour-text"></p>
      <div class="tour-actions">
        <button type="button" class="text-btn" data-tour="skip">Пропустить</button>
        <span class="tour-nav">
          <button type="button" class="btn" data-tour="prev">Назад</button>
          <button type="button" class="btn btn-primary" data-tour="next">Далее</button>
        </span>
      </div>
    </div>`;
  el.addEventListener('click', event => {
    const action = event.target.closest('[data-tour]')?.dataset.tour;
    if (action === 'next') tourGo(tour.index + 1);
    else if (action === 'prev') tourGo(tour.index - 1);
    else if (action === 'skip') endTour();
  });
  document.body.append(el);
  return el;
}

function startTour() {
  if (!app.journals.length) return;
  $$('dialog[open]').forEach(d => d.close());
  if (app.view !== 'journal') setView('journal');
  tour.steps = tourSteps();
  tour.el = tour.el || buildTour();
  tour.el.hidden = false;
  document.body.classList.add('tour-on');
  window.addEventListener('resize', placeTour);
  window.addEventListener('scroll', placeTour, true);
  document.addEventListener('keydown', tourKeys);
  tourGo(0);
}

function endTour() {
  try { localStorage.setItem(tourKey(), '1'); } catch {}
  if (tour.el) tour.el.hidden = true;
  document.body.classList.remove('tour-on');
  window.removeEventListener('resize', placeTour);
  window.removeEventListener('scroll', placeTour, true);
  document.removeEventListener('keydown', tourKeys);
}

function tourKeys(event) {
  if (event.key === 'Escape') endTour();
  else if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); tourGo(tour.index + 1); }
  else if (event.key === 'ArrowLeft') tourGo(tour.index - 1);
}

function tourGo(index) {
  if (index >= tour.steps.length) { endTour(); return; }
  if (index < 0) return;
  // Шаги, для которых нет элемента на экране, пропускаем.
  const dir = index >= tour.index ? 1 : -1;
  while (tour.steps[index]?.target && !visibleTarget(tour.steps[index].target)) index += dir;
  if (index < 0 || index >= tour.steps.length) { if (index >= tour.steps.length) endTour(); return; }
  tour.index = index;
  const step = tour.steps[index], card = tour.el.querySelector('.tour-card');
  const total = tour.steps.length;
  card.querySelector('.tour-count').textContent = 'Шаг ' + (index + 1) + ' из ' + total;
  card.querySelector('#tour-title').textContent = step.title;
  card.querySelector('#tour-text').textContent = step.text;
  card.querySelector('[data-tour="prev"]').hidden = index === 0;
  card.querySelector('[data-tour="skip"]').hidden = !!step.last;
  card.querySelector('[data-tour="next"]').textContent = step.last ? 'Начать работу' : index === 0 ? 'Начать обучение' : 'Далее';
  const target = visibleTarget(step.target);
  if (target) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  placeTour();
  card.querySelector('[data-tour="next"]').focus({ preventScroll: true });
}

function placeTour() {
  if (!tour.el || tour.el.hidden) return;
  const step = tour.steps[tour.index], target = visibleTarget(step.target);
  const hole = tour.el.querySelector('.tour-hole'), card = tour.el.querySelector('.tour-card'), arrow = card.querySelector('.tour-arrow');
  const vw = window.innerWidth, vh = window.innerHeight, gap = 54, pad = 8;
  const pointer = tour.el.querySelector('.tour-pointer');
  tour.el.classList.toggle('centered', !target);
  if (!target) {
    hole.style.cssText = 'display:none';
    card.style.cssText = '';
    arrow.className = 'tour-arrow';
    pointer.style.display = 'none';
    return;
  }
  const r = target.getBoundingClientRect();
  const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad), right: Math.min(vw - 4, r.right + pad), bottom: Math.min(vh - 4, r.bottom + pad) };
  hole.style.cssText = `display:block;left:${box.left}px;top:${box.top}px;width:${box.right - box.left}px;height:${box.bottom - box.top}px`;

  const cw = Math.min(380, vw - 24);
  card.style.width = cw + 'px';
  const ch = card.offsetHeight;
  let side;
  if (vh - box.bottom >= ch + gap + 8) side = 'bottom';
  else if (box.top >= ch + gap + 8) side = 'top';
  else if (vw - box.right >= cw + gap + 8) side = 'right';
  else if (box.left >= cw + gap + 8) side = 'left';
  else side = 'bottom';
  let left, top;
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  if (side === 'bottom' || side === 'top') {
    left = Math.min(Math.max(12, cx - cw / 2), vw - cw - 12);
    top = side === 'bottom' ? Math.min(box.bottom + gap, vh - ch - 12) : box.top - gap - ch;
    arrow.style.cssText = `left:${Math.min(Math.max(20, cx - left), cw - 20)}px`;
  } else {
    top = Math.min(Math.max(12, cy - ch / 2), vh - ch - 12);
    left = side === 'right' ? box.right + gap : box.left - gap - cw;
    arrow.style.cssText = `top:${Math.min(Math.max(20, cy - top), ch - 20)}px`;
  }
  top = Math.max(12, top);
  card.style.left = left + 'px';
  card.style.top = top + 'px';
  arrow.className = 'tour-arrow ' + side;
  // Большая стрелка между подсказкой и подсвеченным элементом, направлена на элемент.
  const ph = 40, rotate = { bottom: 0, top: 180, right: -90, left: 90 }[side];
  let px, py;
  if (side === 'bottom') { px = Math.min(Math.max(left + 20, cx), left + cw - 20); py = (box.bottom + top) / 2; }
  else if (side === 'top') { px = Math.min(Math.max(left + 20, cx), left + cw - 20); py = (box.top + top + card.offsetHeight) / 2; }
  else if (side === 'right') { px = (box.right + left) / 2; py = Math.min(Math.max(top + 20, cy), top + card.offsetHeight - 20); }
  else { px = (box.left + left + cw) / 2; py = Math.min(Math.max(top + 20, cy), top + card.offsetHeight - 20); }
  pointer.style.cssText = `display:grid;left:${px - ph / 2}px;top:${py - ph / 2}px;--rot:${rotate}deg`;
}

function maybeStartTour() {
  let done = false;
  try { done = localStorage.getItem(tourKey()) === '1'; } catch {}
  if (!done) setTimeout(startTour, 700);
}

$$('[data-start-tour]').forEach(b => b.addEventListener('click', () => { $$('dialog[open]').forEach(d => d.close()); startTour(); }));
