'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const merge = require('merge-objects');
const glob = require('glob');

const markbotIgnoreParser = require('./markbot-ignore-parser');
const exists = require('./file-exists');
const stripPath = require('./strip-path');

const getFileCodeLang = function (fullPath) {
  return fullPath.match(/\.(html|css|js)$/)[1];
};

const getAlternativeExtensions = function (ext) {
  switch (ext) {
    // case 'md':
      // return 'md|yml';
      // break;
    default:
      return ext;
  }
};

const findCompatibleFiles = function (folderpath, ignore, ext) {
  const fullPath = path.resolve(folderpath);
  const minFileExts = new RegExp(`min\.(${ext})$`);
  const ignoreRegExps = ignore.map((item) => new RegExp(item));
  const totalIgnores = ignoreRegExps.length;
  let files = glob.sync(`${fullPath}/**/*.+(${ext})`);

  if (!files) return [];

  files = files.filter((file) => {
    let strippedFile = stripPath(file, folderpath);

    if (file.match(minFileExts)) return false;

    for (let i = 0; i < totalIgnores; i++) {
      if (ignoreRegExps[i].test(strippedFile)) return false;
    }

    return true;
  });

  return files;
};

const mergeInheritedFiles = function (markbotFile) {
  let newMarkbotFile = {
    inheritFilesNotFound: [],
  };
  let templates = [];

  markbotFile.inherit.forEach((templateId) => {
    let inheritPath = path.resolve(`${__dirname}/../templates/${templateId}.yml`);

    if (exists.check(inheritPath)) {
      templates.push(yaml.safeLoad(fs.readFileSync(inheritPath, 'utf8')));
    } else {
      newMarkbotFile.inheritFilesNotFound.push(templateId);
    }
  });

  templates.forEach((file) => {
    newMarkbotFile = merge(newMarkbotFile, file);
  });

  newMarkbotFile = merge(newMarkbotFile, markbotFile);

  return newMarkbotFile;
};

const bindFunctionalityToHtmlFiles = function (markbotFile) {
  if (markbotFile.allFiles && markbotFile.allFiles.functionality && markbotFile.html) {
    if (!markbotFile.functionality) markbotFile.functionality = [];

    markbotFile.html.forEach((file) => {
      markbotFile.functionality.push(merge({ path: file.path }, markbotFile.allFiles.functionality));
    });
  }

  return markbotFile;
};

const mergeAllFilesProperties = function (markbotFile, key) {
  if (!markbotFile[key]) return markbotFile;

  markbotFile[key].forEach((item, i) => {
    if (!markbotFile.allFiles[key]) return;

    if ('path' in markbotFile[key][i] && markbotFile.allFiles[key].except) {
      if (markbotFile.allFiles[key].except.includes(markbotFile[key][i].path)) return;
    }

    markbotFile[key][i] = merge(Object.assign({}, markbotFile.allFiles[key]), item);
  });

  return markbotFile;
};

const bindAllFilesProperties = function (folderpath, ignoreFiles, markbotFile, next) {
  const keys = ['html', 'css', 'js', 'md', 'yml', 'files', 'functionality', 'performance'];

  keys.forEach((key) => {
    if (!markbotFile[key] && !markbotFile.allFiles[key]) return;

    if (markbotFile.allFiles[key] && !markbotFile[key]) {
      let files = findCompatibleFiles(folderpath, ignoreFiles, getAlternativeExtensions(key));

      if (!files) next(markbotFile);

      files.forEach((file) => {
        if (!markbotFile[key]) markbotFile[key] = [];

        markbotFile[key].push({ path: stripPath(file, folderpath), });
      });
    }

    markbotFile = mergeAllFilesProperties(markbotFile, key);
  });

  if (markbotFile.allFiles.html.screenshots) {
    if (!markbotFile.screenshots) markbotFile.screenshots = [];

    markbotFile.html.forEach((item, i) => {
      markbotFile.screenshots.push({
        path: item.path,
        sizes: markbotFile.allFiles.html.screenshots,
      });
    });
  }

  next(markbotFile);
};

const removeDuplicateScreenshotSizes = function (markbotFile) {
  if (!markbotFile.screenshots) return markbotFile;

  markbotFile.screenshots.forEach((item, i) => {
    markbotFile.screenshots[i].sizes = [...new Set(markbotFile.screenshots[i].sizes)];
  });

  return markbotFile;
};

const mergeDuplicateFiles = function (markbotFile) {
  const keys = ['html', 'css', 'js', 'md', 'yml', 'files', 'screenshots', 'functionality', 'performance'];

  keys.forEach((key) => {
    let paths = {};

    if (!markbotFile[key]) return;

    markbotFile[key].forEach((item, i) => {
      if (!item.path) return;

      if (item.path in paths) {
        markbotFile[key][paths[item.path]] = merge(markbotFile[key][paths[item.path]], item);
        markbotFile[key].splice(i, 1);
      } else {
        paths[item.path] = i;
      }
    });
  });

  return removeDuplicateScreenshotSizes(markbotFile);
};

const populateDefaults = function (folderpath, ignoreFiles, markbotFile, next) {
  if (!markbotFile.allFiles && !markbotFile.inherit) return next(markbotFile, ignoreFiles);
  if (markbotFile.inherit) markbotFile = mergeInheritedFiles(markbotFile);

  if (markbotFile.allFiles) {
    bindAllFilesProperties(folderpath, ignoreFiles, markbotFile, (mf) => {
      next(mergeDuplicateFiles(bindFunctionalityToHtmlFiles(mf)), ignoreFiles);
    });
  } else {
    next(mergeDuplicateFiles(markbotFile), ignoreFiles);
  }
}

const getMarkbotFile = function (markbotFilePath, next) {
  let markbotFile = yaml.safeLoad(fs.readFileSync(markbotFilePath, 'utf8'));
  let folderpath = path.parse(markbotFilePath).dir;

  markbotIgnoreParser.parse(folderpath, (ignoreFiles) => {
    populateDefaults(folderpath, ignoreFiles, markbotFile, next);
  });
};

const buildFromFolder = function (folderpath, next) {
  let markbotFile = yaml.safeLoad(fs.readFileSync(path.resolve(__dirname + '/../templates/basic-dropped-folder.yml'), 'utf8'));

  markbotIgnoreParser.parse(folderpath, (ignoreFiles) => {
    populateDefaults(folderpath, ignoreFiles, markbotFile, next);
  });
};

module.exports = {
  get: getMarkbotFile,
  buildFromFolder: buildFromFolder
};
