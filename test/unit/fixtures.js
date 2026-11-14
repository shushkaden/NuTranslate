'use strict';

// Lithuanian news-style paragraphs.
const LT = [
  'Lietuvos Respublikos Vyriausybė šiandien pritarė naujam įstatymo projektui, kuris numato didesnį finansavimą švietimui ir sveikatos apsaugai. Ministras pirmininkas pabrėžė, kad reformos bus įgyvendinamos palaipsniui.',
  'Vilniaus miesto savivaldybė praneša, kad nuo kitos savaitės bus remontuojamos kelios pagrindinės gatvės, todėl vairuotojai raginami rinktis alternatyvius maršrutus ir iš anksto planuoti kelionės laiką.',
  'Sinoptikai prognozuoja, kad savaitgalį visoje šalyje bus šilta ir saulėta, tačiau vakarinėje Lietuvos dalyje gali trumpai palyti. Naktį temperatūra nukris iki dešimties laipsnių šilumos.',
  'Kauno klinikose pradėtas naudoti naujas diagnostikos įrenginys, leisiantis greičiau nustatyti širdies ligas. Gydytojų teigimu, pacientams nebereikės laukti tyrimų kelias savaites.',
  'Klaipėdos uoste šiais metais perkrauta daugiau krovinių nei pernai. Uosto direkcija tikisi, kad augimas tęsis ir kitais metais, nes planuojama išplėsti konteinerių terminalą.',
  'Lietuvos krepšinio rinktinė pergalingai pradėjo atrankos varžybas į pasaulio čempionatą. Treneris po rungtynių sakė, kad komanda dar turi daug ką tobulinti gynyboje.',
];

const EN = {
  skip: 'Skip to main content Skip to search Skip to footer navigation Accessibility statement',
  cookie: 'We use cookies and similar technologies to improve your browsing experience, personalise content and ads, provide social media features and analyse our traffic. By clicking Accept all you consent to the use of all cookies. You can manage your preferences at any time by visiting our cookie policy page.',
  footer: '© 2026 Example Media. All rights reserved. Privacy Policy, Terms of Use, Cookie Settings, Contact us, Advertise with us.',
  article: [
    'The city council approved a new transport plan on Tuesday that will add three bus lines and extend the tram network to the northern suburbs. Officials said construction should begin next spring.',
    'Researchers at the university have developed a battery that charges in under ten minutes and keeps most of its capacity after thousands of cycles, according to a study published this week.',
    'Forecasters expect a warm and sunny weekend across the country, although short showers are possible in the west. Night temperatures will drop to around ten degrees.',
  ],
};

/**
 * A stand-in for chrome.i18n.detectLanguage, good enough for testing the
 * decision logic: Lithuanian letters mean Lithuanian, plain Latin means English.
 */
function fakeDetect(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (!letters) return { isReliable: false, languages: [] };
  const ltLetters = (text.match(/[ąčęėįšųūž]/gi) || []).length;
  const lt = ltLetters / letters > 0.01;
  return {
    isReliable: Buffer.byteLength(text) >= 50,
    languages: [{ language: lt ? 'lt' : 'en', percentage: 100 }],
  };
}

module.exports = { LT, EN, fakeDetect };
