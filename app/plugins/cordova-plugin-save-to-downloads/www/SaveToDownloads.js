var exec = require('cordova/exec');

var SaveToDownloads = {
    save: function (filename, content, mime, success, error) {
        exec(success, error, 'SaveToDownloads', 'save', [filename, content, mime]);
    }
};

module.exports = SaveToDownloads;
