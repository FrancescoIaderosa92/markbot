(function () {
  'use strict';

  const path = require('path');
  const merge = require('merge-objects');
  const ipcMain = require('electron').remote.ipcMain;
  const webcoach = require('webcoach');
  const webLoader = require('./web-loader');
  const adviceIgnoreIds = require('./checks/performance/ignore-advice-ids.json');
  const webServer = require('electron').remote.require('./app/web-server');
  const markbotMain = require('electron').remote.require('./app/markbot-main');

  const group = taskDetails.group;
  const fullPath = taskDetails.cwd;

  let totalFiles = 0;

  const perfDefaults = {
    speed: 'WIFI',
    budget: {
      maxLoadTime: 1000,
      maxRequests: 15,
      maxSize: 800,
      maxFonts: 5,
    }
  };

  const getPerformanceSettings = function (filePerf) {
    return merge(Object.assign({}, perfDefaults), filePerf);
  };

  const sizeToNum = function (size) {
    let isMb = size.match(/mb/i);
    let num = parseFloat(size.replace(/[^\d\.]/, ''));

    if (isMb) num *= 1024;

    return num;
  };

  const makeJs = function () {
    return `
      (function () {
        const webcoach = nodeRequire('webcoach');

        webcoach.getDomAdvice().then(function (data) {
          console.log(data);
          nodeRequire('electron').ipcRenderer.send('__markbot-hidden-browser-perf-dom-advice', JSON.stringify(eval(data)));
        });
      }());
    `;
  };

  const generateBudgetReport = function (perf, advice) {
    const budget = perf.budget;
    let message = `The website passes the performance budget requirements of a simulated ${perf.speed} network`;

    if (!doesPassPerfBudget(perf, advice)) {
      message = `The website fails the performance budget requirements of a simulated ${perf.speed} network`;
    }

    return {
      type: 'table',
      message: message,
      headings: ['', 'Load time', 'Requests', 'Size'],
      rows: [
        {
          title: 'Budget',
          data: [
            `< ${budget.maxLoadTime} ms`,
            `< ${budget.maxRequests}`,
            `< ${budget.maxSize} kB`,
          ],
        },
        {
          title: 'Actual',
          highlight: true,
          data: [
            (advice.timings.fullyLoaded > budget.maxLoadTime) ? `***${Math.round(advice.timings.fullyLoaded)} ms***` : `${Math.round(advice.timings.fullyLoaded)} ms`,
            (advice.info.pageRequests > budget.maxRequests) ? `***${advice.info.pageRequests}***` : advice.info.pageRequests,
            (sizeToNum(advice.info.pageTransferSize) > budget.maxSize) ? `***${advice.info.pageTransferSize}***` : advice.info.pageTransferSize,
          ],
        },
      ],
    };
  };

  const doesPassPerfBudget = function (perf, advice) {
    const budget = perf.budget;

    if (advice.timings.fullyLoaded > budget.maxLoadTime) return false;
    if (advice.info.pageRequests > budget.maxRequests) return false;
    if (sizeToNum(advice.info.pageTransferSize) > budget.maxSize) return false;

    return true;
  };

  const generateOffendingFileList = function (advice) {
    let error = '';

    if (advice.offending.length > 0) {
      let offending = [];

      advice.offending.forEach(function (file) {
        let simpleFile = file.replace(webServer.getHost(), '');

        offending.push(`\`${simpleFile}\``);
      });

      error += ' ' + offending.join(', ');
    }

    return error;
  };

  const shouldIncludeError = function (id, perf, advice) {
    if (adviceIgnoreIds.indexOf(id) > -1) return false;
    if (advice.score >= 100) return false;

    if (id == 'fewFonts' && advice.score >= (100 - (perf.budget.maxFonts * 10))) return false;

    return true;
  };

  const check = function (file, next) {
    let win;
    let har;
    let perf = getPerformanceSettings(file);
    let label = `${file.path} — ${perf.speed}`

    ipcMain.on('__markbot-hidden-browser-perf-dom-advice', function (event, data) {
      var domAdvice = JSON.parse(data);

      ipcMain.removeAllListeners('__markbot-hidden-browser-perf-dom-advice');
      webLoader.destroy(win);
      win = null;

      webcoach.runHarAdvice(webcoach.pickAPage(har, 0), webcoach.getHarAdvice()).then(function (harAdvice) {
        const coachResults = webcoach.merge(domAdvice, harAdvice);
        const coachAdvice = coachResults.advice;
        let errors = [];
        let messages = [];
        let budgetDetails = generateBudgetReport(perf, coachAdvice);

        if (doesPassPerfBudget(perf, coachAdvice)) {
          messages.push(budgetDetails);
        } else {
          errors.push(budgetDetails);
        }

        markbotMain.debug(`Performance score: ${coachAdvice.score}`);

        Object.keys(coachAdvice.performance.adviceList).forEach(function (id) {
          let advice = coachAdvice.performance.adviceList[id];
          let error = `**${advice.title}** — ${advice.advice}`;

          if (shouldIncludeError(id, perf, advice)) {
            error += generateOffendingFileList(advice);
            errors.push(error);
          }
        });

        if (errors.length <= 0) {
          markbotMain.send('check-group:item-complete', group, file.path, label, [], '', messages);
        } else {
          markbotMain.send('check-group:item-complete', group, file.path, label, errors, '', messages);
        }

        next();
      });
    });

    markbotMain.send('check-group:item-new', group, file.path, label);
    markbotMain.send('check-group:item-computing', group, file.path, label);

    webLoader.load(file.path, {speed: perf.speed}, function (theWindow, theHar) {
      win = theWindow;
      har = theHar;
      win.webContents.executeJavaScript(makeJs());
    });
  };

  const checkIfDone = function () {
    totalFiles--;

    if (totalFiles <= 0) done();
  };

  taskDetails.options.files.forEach(function (file) {
    totalFiles++;
    check(file, checkIfDone);
  });
}());