package com.aura.app;

import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.telephony.PhoneNumberUtils;
import android.telephony.TelephonyManager;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads the phone's contacts to resolve a spoken name. Needs READ_CONTACTS (asked for only when a command names a
 * person). Contacts are read on the phone for that one lookup: they are not copied, stored, logged or sent anywhere.
 */
final class ContactsLookup {

    private ContactsLookup() { }

    /** The saved people a spoken name could mean (see ContactMatcher). Empty when nobody matches. */
    static List<ContactMatcher.Entry> find(Context ctx, String spokenName) {
        List<ContactMatcher.Entry> all = new ArrayList<>();
        String[] columns = {
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
                ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY,
                ContactsContract.CommonDataKinds.Phone.TYPE,
        };
        try (Cursor c = ctx.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, columns, null, null, null)) {
            while (c != null && c.moveToNext()) {
                String name = c.getString(1);
                String number = c.getString(2);
                if (name == null || number == null) continue;
                all.add(new ContactMatcher.Entry(c.getLong(0), name, number, c.getInt(3) != 0,
                        c.getInt(4) == ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE));
            }
        } catch (SecurityException e) {
            return new ArrayList<>();
        }
        return ContactMatcher.match(all, spokenName);
    }

    /**
     * The contact's own WhatsApp entry of the given kind (chat, voice call, video call), as WhatsApp publishes it in
     * the phone's contacts. Opening it goes to exactly that person. Null when the contact has none (not on WhatsApp).
     */
    static Uri whatsAppRow(Context ctx, ContactMatcher.Entry contact, String mimeType) {
        String[] columns = {ContactsContract.Data._ID, ContactsContract.Data.DATA1};
        String where = ContactsContract.Data.CONTACT_ID + "=? AND " + ContactsContract.Data.MIMETYPE + "=?";
        String tail = ContactMatcher.tail(contact.number);
        Uri first = null;
        try (Cursor c = ctx.getContentResolver().query(ContactsContract.Data.CONTENT_URI, columns, where,
                new String[]{String.valueOf(contact.id), mimeType}, null)) {
            while (c != null && c.moveToNext()) {
                Uri row = ContentUris.withAppendedId(ContactsContract.Data.CONTENT_URI, c.getLong(0));
                String jid = c.getString(1);   // "<number>@s.whatsapp.net"
                if (jid != null && !tail.isEmpty() && jid.replaceAll("@.*", "").endsWith(tail)) return row;
                if (first == null) first = row;
            }
        } catch (SecurityException e) {
            return null;
        }
        return first;
    }

    /** The number with its country code, digits only ("919876543210"), as wa.me links need. Null if it can't be worked out. */
    static String international(Context ctx, String number) {
        if (number == null) return null;
        String trimmed = number.trim();
        if (trimmed.startsWith("+")) return trimmed.replaceAll("\\D", "");
        String iso = "";
        TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
        if (tm != null) {
            iso = tm.getNetworkCountryIso();
            if (iso == null || iso.isEmpty()) iso = tm.getSimCountryIso();
        }
        if (iso == null || iso.isEmpty()) iso = Locale.getDefault().getCountry();
        String e164 = PhoneNumberUtils.formatNumberToE164(trimmed, iso.toUpperCase(Locale.ROOT));
        return e164 == null ? null : e164.replaceAll("\\D", "");
    }
}
