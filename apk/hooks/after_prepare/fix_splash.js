#!/usr/bin/env node
'use strict';
// Fixes the Android 12+ splash screen so it shows a dark background
// instead of the default Cordova icon/white flash before the WebView loads.
const fs   = require('fs');
const path = require('path');

module.exports = function(context) {
  const platformDir = path.join(context.opts.projectRoot, 'platforms', 'android');
  if (!fs.existsSync(platformDir)) return;

  const valuesDir = path.join(platformDir, 'app', 'src', 'main', 'res', 'values');
  fs.mkdirSync(valuesDir, { recursive: true });

  // 1. Ensure the dark color exists
  const colorsPath = path.join(valuesDir, 'colors.xml');
  let colors = fs.existsSync(colorsPath) ? fs.readFileSync(colorsPath, 'utf8') : '<resources>\n</resources>';
  if (colors.includes('giscatasto_splash_bg')) {
    colors = colors.replace(/<color name="giscatasto_splash_bg">[^<]*<\/color>/, '<color name="giscatasto_splash_bg">#080d1a</color>');
  } else {
    colors = colors.replace('</resources>', '  <color name="giscatasto_splash_bg">#080d1a</color>\n</resources>');
  }
  fs.writeFileSync(colorsPath, colors, 'utf8');

  // 2. Write a solid-background vector drawable matching the splash background.
  //    An empty <vector> still shows a visible icon area on Android 12+;
  //    a solid fill matching the background color makes it invisible.
  const drawableDir = path.join(platformDir, 'app', 'src', 'main', 'res', 'drawable');
  fs.mkdirSync(drawableDir, { recursive: true });
  fs.writeFileSync(
    path.join(drawableDir, 'giscatasto_splash_transparent.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n' +
    '    android:width="108dp" android:height="108dp"\n' +
    '    android:viewportWidth="108" android:viewportHeight="108">\n' +
    '  <path android:fillColor="#080d1a"\n' +
    '        android:pathData="M0,0 L108,0 L108,108 L0,108 Z"/>\n' +
    '</vector>\n',
    'utf8'
  );

  // 3. Patch every theme file under values*/ (values/, values-v31/, values-night-v31/, …).
  //    Android 12+ (API 31) uses values-v31 for the SplashScreen API attributes.
  //    Match any *themes.xml, not just "themes.xml": cordova-android 15 renamed the generated
  //    file to cdv_themes.xml, and looking for the old name alone made this hook find nothing
  //    and return early — the colour and drawable below were still written, but no theme
  //    referenced them, so the stock Cordova icon kept showing over a near-white background.
  const resDir = path.join(platformDir, 'app', 'src', 'main', 'res');
  const themesCandidates = [];
  try {
    fs.readdirSync(resDir).forEach(d => {
      if (!d.startsWith('values')) return;
      const dir = path.join(resDir, d);
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch(_) { return; }
      entries.forEach(f => {
        if (/themes\.xml$/i.test(f)) themesCandidates.push(path.join(dir, f));
      });
    });
  } catch(_) {}
  // Fallback: original path
  const fallback = path.join(valuesDir, 'themes.xml');
  if (!themesCandidates.length && fs.existsSync(fallback)) themesCandidates.push(fallback);
  if (!themesCandidates.length) return;

  themesCandidates.forEach(themesPath => {
    let xml = fs.readFileSync(themesPath, 'utf8');

    // Remove IconBackground parent to suppress the circular icon backdrop
    xml = xml.replace('Theme.SplashScreen.IconBackground', 'Theme.SplashScreen');

    // Keep names WITHOUT android: prefix — prepare.js searches for these exact names
    xml = xml.replace(
      /<item name="(?:android:)?windowSplashScreenBackground">[^<]*<\/item>/g,
      '<item name="windowSplashScreenBackground">@color/giscatasto_splash_bg</item>'
    );
    if (xml.includes('windowSplashScreenAnimatedIcon')) {
      xml = xml.replace(
        /\s*<item name="(?:android:)?windowSplashScreenAnimatedIcon">[^<]*<\/item>/g,
        '\n        <item name="windowSplashScreenAnimatedIcon">@drawable/giscatasto_splash_transparent</item>'
      );
    } else if (xml.includes('windowSplashScreen') || xml.includes('Splash') || xml.includes('AppTheme')) {
      xml = xml.replace(
        /(<style\b[^>]*>)/,
        '$1\n        <item name="windowSplashScreenAnimatedIcon">@drawable/giscatasto_splash_transparent</item>'
      );
    }
    // Icon background: keep without android: prefix so prepare.js can find/remove it
    xml = xml.replace(
      /<item name="(?:android:)?windowSplashScreenIconBackgroundColor">[^<]*<\/item>/g,
      '<item name="windowSplashScreenIconBackgroundColor">@color/giscatasto_splash_bg</item>'
    );
    if (!xml.includes('windowSplashScreenIconBackgroundColor')) {
      xml = xml.replace(
        /(<style\b[^>]*>)/,
        '$1\n        <item name="windowSplashScreenIconBackgroundColor">@color/giscatasto_splash_bg</item>'
      );
    }
    if (!xml.includes('android:windowBackground')) {
      xml = xml.replace(
        /(<style\b[^>]*>)/,
        '$1\n        <item name="android:windowBackground">@color/giscatasto_splash_bg</item>'
      );
    }

    fs.writeFileSync(themesPath, xml, 'utf8');
  });

};
