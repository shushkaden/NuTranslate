'use strict';

/*
 * Test pages for the end-to-end run. Each case says what Chrome's translate
 * component should adopt as the page language once NuTranslate is active
 * (checked only when the real language model is loaded) and what the content
 * script should report.
 */

const { LT: LT_BASE, EN } = require('../unit/fixtures.js');

const LT = LT_BASE.concat([
  'Valstybinė mokesčių inspekcija primena, kad gyventojai pajamų deklaracijas turi pateikti iki gegužės pirmosios dienos. Deklaruoti galima elektroniniu būdu, prisijungus prie savitarnos sistemos.',
  'Nacionalinis muziejus atidarė naują parodą, skirtą Lietuvos istorijai ir kultūrai. Lankytojai galės pamatyti archeologinius radinius, senuosius žemėlapius ir unikalių dokumentų kopijas.',
  'Ekonomistai pastebi, kad infliacija šalyje lėtėja, tačiau maisto produktų kainos vis dar išlieka aukštos. Centrinis bankas artimiausiu metu palūkanų normų keisti neplanuoja.',
  'Šiaulių rajone ūkininkai baigė javų nuėmimą. Šiemet derlius buvo didesnis nei tikėtasi, todėl dalis grūdų bus eksportuojama į kaimynines šalis.',
  'Universiteto mokslininkai sukūrė programėlę, kuri padeda mokiniams lengviau išmokti matematikos. Programėlė jau išbandyta keliose Vilniaus mokyklose ir sulaukė gerų atsiliepimų.',
  'Kelių priežiūros tarnybos įspėja, kad dėl numatomos šlapdribos ir plikledžio eismo sąlygos gali pablogėti. Vairuotojams patariama be būtinybės nesiruošti tolimoms kelionėms.',
]);

const RU = [
  'Правительство Литвы сегодня одобрило новый законопроект, который предусматривает увеличение финансирования образования и здравоохранения. Премьер-министр подчеркнул, что реформы будут проводиться постепенно.',
  'Мэрия Вильнюса сообщает, что со следующей недели начнётся ремонт нескольких главных улиц, поэтому водителям рекомендуют заранее выбирать объездные маршруты и планировать время в пути.',
  'Синоптики обещают, что в выходные по всей стране будет тепло и солнечно, однако на западе возможны кратковременные дожди. Ночью температура опустится до десяти градусов тепла.',
  'В клиниках Каунаса начали использовать новое диагностическое оборудование, которое позволит быстрее выявлять болезни сердца. По словам врачей, пациентам больше не придётся ждать обследования неделями.',
];

const LV = [
  'Latvijas valdība šodien atbalstīja jaunu likumprojektu, kas paredz lielāku finansējumu izglītībai un veselības aprūpei. Ministru prezidents uzsvēra, ka reformas tiks īstenotas pakāpeniski.',
  'Rīgas pašvaldība informē, ka no nākamās nedēļas tiks remontētas vairākas galvenās ielas, tāpēc autovadītāji tiek aicināti savlaicīgi izvēlēties alternatīvus maršrutus.',
  'Sinoptiķi prognozē, ka nedēļas nogalē visā valstī būs silts un saulains laiks, taču valsts rietumos iespējams īslaicīgs lietus. Naktī temperatūra pazemināsies līdz desmit grādiem.',
  'Daugavpils slimnīcā sākta jaunas diagnostikas iekārtas izmantošana, kas ļaus ātrāk atklāt sirds slimības. Ārsti norāda, ka pacientiem vairs nebūs jāgaida izmeklējumi vairākas nedēļas.',
];

const EN_MORE = EN.article.concat([
  'The museum opened a new exhibition about the history of the region, with archaeological finds, old maps and copies of rare documents on display until the end of the year.',
  'Economists note that inflation is slowing down, but food prices remain high, and the central bank does not plan to change interest rates in the coming months.',
]);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paragraphs = (list) => list.map((p) => `<p>${esc(p)}</p>`).join('\n');

const SKIP_LINKS = '<a class="skip" href="#main">Skip to main content</a> <a class="skip" href="#search">Skip to search</a> <a class="skip" href="#footer">Skip to footer navigation</a>';
const LT_NAV = '<header><nav><a href="#">Pradžia</a> <a href="#">Naujienos</a> <a href="#">Verslas</a> <a href="#">Sportas</a> <a href="#">Kultūra</a> <a href="#">Kontaktai</a></nav></header>';
const EN_COOKIE = `<div id="cookie-banner" role="dialog"><p>${esc(EN.cookie)}</p><button>Accept all</button> <button>Reject all</button> <button>Manage preferences</button></div>`;
const EN_FOOTER = `<footer id="footer"><p>${esc(EN.footer)}</p></footer>`;

function page({ lang, title = 'Naujienos', head = '', body }) {
  const langAttr = lang === null ? '' : ` lang="${lang}"`;
  return `<!doctype html>
<html${langAttr}>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${head}
</head>
<body>
${body}
</body>
</html>
`;
}

function bigLithuanianPage() {
  const blocks = [];
  for (let i = 0; i < 320; i++) {
    const p = LT[i % LT.length];
    blocks.push(`<div class="card"><div class="inner"><div class="meta"><span>${i + 1}</span> <span>Naujiena</span></div><h3>Straipsnis ${i + 1}</h3><p>${esc(p)}</p></div></div>`);
  }
  return page({ lang: 'en', body: `${SKIP_LINKS}\n${LT_NAV}\n<main id="main">${blocks.join('\n')}</main>\n${EN_COOKIE}\n${EN_FOOTER}` });
}

function englishInTheMiddle() {
  const half = paragraphs(LT.concat(LT.slice(0, 4)));
  const english = `<blockquote>${paragraphs(EN_MORE.slice(0, 3))}</blockquote>`;
  return page({ lang: 'lt', body: `<main id="main">${half}\n${english}\n${half}</main>` });
}

const SPA_HEAD = '<meta name="description" content="Naujausios Lietuvos ir pasaulio naujienos, analitiniai straipsniai, interviu ir komentarai apie politiką, ekonomiką, sportą bei kultūrą.">';
const SPA_SCRIPT = `<script>
setTimeout(function () {
  document.getElementById('root').innerHTML = ${JSON.stringify(paragraphs(LT.slice(0, 4)))};
}, 400);
</script>`;

const RESET_SCRIPT = `<script>
document.addEventListener('DOMContentLoaded', function () {
  document.documentElement.lang = 'en';
  setTimeout(function () { document.documentElement.setAttribute('lang', 'en-US'); }, 0);
});
</script>`;

const cases = [
  {
    name: 'lt-declared-en',
    about: 'Lithuanian article, page says lang="en"',
    html: page({ lang: 'en', body: `<main id="main">${paragraphs(LT)}</main>` }),
    expect: { status: 'changed', adopted: 'lt' },
  },
  {
    name: 'lt-declared-en-boilerplate',
    about: 'Same, plus English skip links, cookie banner and footer',
    html: page({ lang: 'en', body: `${SKIP_LINKS}\n${LT_NAV}\n<main id="main">${paragraphs(LT)}</main>\n${EN_COOKIE}\n${EN_FOOTER}` }),
    expect: { status: 'changed', adopted: 'lt', steered: true },
  },
  {
    name: 'lt-declared-lt-boilerplate',
    about: 'Correct lang="lt", but English boilerplate misleads the model',
    html: page({ lang: 'lt', body: `${SKIP_LINKS}\n${LT_NAV}\n<main id="main">${paragraphs(LT)}</main>\n${EN_COOKIE}\n${EN_FOOTER}` }),
    expect: { status: 'kept', adopted: 'lt', steered: true },
  },
  {
    name: 'lt-declared-lt-clean',
    about: 'Correct lang="lt-LT", nothing to do',
    html: page({ lang: 'lt-LT', body: `<main id="main">${paragraphs(LT)}</main>` }),
    expect: { status: 'kept', adopted: 'lt', steered: false },
  },
  {
    name: 'en-article',
    about: 'English article with lang="en"',
    html: page({ lang: 'en', title: 'News', body: `<main id="main">${paragraphs(EN_MORE)}</main>` }),
    expect: { status: 'kept', adopted: 'en', steered: false },
  },
  {
    name: 'lt-no-lang-header-en',
    about: 'No lang attribute, HTTP Content-Language: en',
    headers: { 'Content-Language': 'en' },
    html: page({ lang: null, body: `<main id="main">${paragraphs(LT)}</main>` }),
    expect: { status: 'changed', adopted: 'lt' },
  },
  {
    name: 'lt-page-resets-lang',
    about: 'Page script resets lang="en" after DOMContentLoaded',
    html: page({ lang: 'en', head: RESET_SCRIPT, body: `<main id="main">${paragraphs(LT)}</main>` }),
    expect: { status: 'changed', adopted: 'lt', guard: true },
  },
  {
    name: 'ru-declared-en',
    about: 'Russian article with lang="en"',
    html: page({ lang: 'en', title: 'Новости', body: `<main id="main">${paragraphs(RU)}</main>` }),
    expect: { status: 'changed', adopted: 'ru' },
  },
  {
    name: 'lv-declared-lt',
    about: 'Latvian article with lang="lt"',
    html: page({ lang: 'lt', title: 'Ziņas', body: `<main id="main">${paragraphs(LV)}</main>` }),
    expect: { status: 'changed', adopted: 'lv' },
  },
  {
    name: 'mixed-lt-en',
    about: 'Half Lithuanian, half English: left alone',
    html: page({ lang: 'en', body: `<main id="main">${paragraphs(LT.slice(0, 4))}\n${paragraphs(EN_MORE.slice(0, 4))}</main>` }),
    expect: { status: 'uncertain' },
  },
  {
    name: 'spa-empty-body',
    about: 'Single-page app: empty body at load, Lithuanian title and description',
    html: page({ lang: 'en', title: 'Naujienos ir straipsniai apie Lietuvą', head: SPA_HEAD, body: `<div id="root"></div>\n${SPA_SCRIPT}` }),
    expect: { status: 'changed', adopted: 'lt' },
  },
  {
    name: 'lt-english-middle',
    about: 'lang="lt", an English quote lands in the middle sample',
    html: englishInTheMiddle(),
    expect: { status: 'kept', adopted: 'lt', steered: true },
  },
  {
    name: 'big-lt',
    about: 'Large page: 320 cards, about 70k characters, lang="en"',
    html: bigLithuanianPage(),
    expect: { status: 'changed', adopted: 'lt' },
  },
  {
    name: 'steering-off',
    about: 'lt-declared-en-boilerplate with hints turned off in settings',
    settings: { steering: false },
    html: page({ lang: 'en', body: `${SKIP_LINKS}\n${LT_NAV}\n<main id="main">${paragraphs(LT)}</main>\n${EN_COOKIE}\n${EN_FOOTER}` }),
    expect: { status: 'changed', adopted: 'und', steered: false },
  },
  {
    name: 'disabled-host',
    about: 'Same as lt-declared-en, but the site is turned off in settings',
    host: 'localhost',
    settings: { disabledHosts: ['localhost'] },
    html: page({ lang: 'en', body: `<main id="main">${paragraphs(LT)}</main>` }),
    expect: { noScript: true, htmlLang: 'en' },
  },
  {
    name: 're-enabled-host',
    about: 'The same site after it is turned back on',
    host: 'localhost',
    html: page({ lang: 'en', body: `<main id="main">${paragraphs(LT)}</main>` }),
    expect: { status: 'changed', htmlLang: 'lt' },
  },
];

const warmup = page({ lang: 'en', title: 'Warm up', body: `<p>${esc(EN.article[0])}</p>` });

module.exports = { cases, warmup };
