package com.geotool.app;

import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;

public class SaveToDownloads extends CordovaPlugin {

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        if (!"save".equals(action)) return false;

        final String filename = args.getString(0);
        final String content  = args.getString(1);
        final String mime     = args.getString(2);

        if (content == null || content.length() == 0) {
            callbackContext.error("Content is empty");
            return true;
        }

        cordova.getThreadPool().execute(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveViaMediaStore(filename, content, mime, callbackContext);
            } else {
                saveDirectly(filename, content, callbackContext);
            }
        });
        return true;
    }

    private void saveViaMediaStore(String filename, String content, String mime, CallbackContext cb) {
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Downloads.DISPLAY_NAME, filename);
        cv.put(MediaStore.Downloads.MIME_TYPE, mime);
        cv.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri uri = cordova.getActivity().getContentResolver()
                .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        if (uri == null) {
            cb.error("MediaStore insert failed — storage may be unavailable");
            return;
        }

        boolean written = false;
        try {
            OutputStream raw = cordova.getActivity().getContentResolver().openOutputStream(uri);
            if (raw == null) throw new IOException("openOutputStream returned null for " + uri);
            try (Writer w = new OutputStreamWriter(raw, StandardCharsets.UTF_8)) {
                w.write(content);
                w.flush();
            }
            written = true;
        } catch (Exception e) {
            // Delete the IS_PENDING entry to avoid a zombie 0-byte file in Downloads
            try { cordova.getActivity().getContentResolver().delete(uri, null, null); } catch (Exception ignored) {}
            cb.error("Write failed: " + e.getMessage());
            return;
        }

        // Mark complete so the file becomes visible in the file manager
        cv.clear();
        cv.put(MediaStore.Downloads.IS_PENDING, 0);
        cordova.getActivity().getContentResolver().update(uri, cv, null, null);
        cb.success();
    }

    private void saveDirectly(String filename, String content, CallbackContext cb) {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            cb.error("Cannot create Downloads directory");
            return;
        }
        File f = new File(dir, filename);
        try (Writer w = new OutputStreamWriter(new FileOutputStream(f, false), StandardCharsets.UTF_8)) {
            w.write(content);
            w.flush();
            cb.success();
        } catch (Exception e) {
            if (f.exists()) f.delete();
            cb.error("Write failed: " + e.getMessage());
        }
    }
}
