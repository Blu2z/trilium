const sql = require('./sql');
const options = require('./options');
const utils = require('./utils');
const notes = require('./notes');
const data_encryption = require('./data_encryption');
const sync_table = require('./sync_table');

async function createNewNote(parentNoteId, note, sourceId) {
    const noteId = utils.newNoteId();
    const noteTreeId = utils.newNoteTreeId();

    let newNotePos = 0;

    await sql.doInTransaction(async () => {
        if (note.target === 'into') {
            const maxNotePos = await sql.getSingleValue('SELECT MAX(note_position) FROM notes_tree WHERE parent_note_id = ? AND is_deleted = 0', [parentNoteId]);

            newNotePos = maxNotePos === null ? 0 : maxNotePos + 1;
        }
        else if (note.target === 'after') {
            const afterNote = await sql.getSingleResult('SELECT note_position FROM notes_tree WHERE note_tree_id = ?', [note.target_note_tree_id]);

            newNotePos = afterNote.note_position + 1;

            // not updating date_modified to avoig having to sync whole rows
            await sql.execute('UPDATE notes_tree SET note_position = note_position + 1 WHERE parent_note_id = ? AND note_position > ? AND is_deleted = 0',
                [parentNoteId, afterNote.note_position]);

            await sync_table.addNoteReorderingSync(parentNoteId, sourceId);
        }
        else {
            throw new Error('Unknown target: ' + note.target);
        }

        const now = utils.nowDate();

        await sql.insert("notes", {
            note_id: noteId,
            note_title: note.note_title,
            note_text: '',
            date_created: now,
            date_modified: now,
            is_protected: note.is_protected
        });

        await sync_table.addNoteSync(noteId, sourceId);

        await sql.insert("notes_tree", {
            note_tree_id: noteTreeId,
            note_id: noteId,
            parent_note_id: parentNoteId,
            note_position: newNotePos,
            is_expanded: 0,
            date_modified: now,
            is_deleted: 0
        });

        await sync_table.addNoteTreeSync(noteTreeId, sourceId);
    });

    return {
        noteId,
        noteTreeId
    };
}

async function encryptNote(note, dataKey) {
    note.detail.note_title = data_encryption.encrypt(dataKey, data_encryption.noteTitleIv(note.detail.note_id), note.detail.note_title);
    note.detail.note_text = data_encryption.encrypt(dataKey, data_encryption.noteTextIv(note.detail.note_id), note.detail.note_text);
}

async function protectNoteRecursively(noteId, dataKey, protect, sourceId) {
    const note = await sql.getSingleResult("SELECT * FROM notes WHERE note_id = ?", [noteId]);

    await protectNote(note, dataKey, protect, sourceId);

    const children = await sql.getFlattenedResults("SELECT note_id FROM notes_tree WHERE parent_note_id = ?", [noteId]);

    for (const childNoteId of children) {
        await protectNoteRecursively(childNoteId, dataKey, protect, sourceId);
    }
}

function decryptNote(note, dataKey) {
    note.note_title = data_encryption.decryptString(dataKey, data_encryption.noteTitleIv(note.note_id), note.note_title);
    note.note_text = data_encryption.decryptString(dataKey, data_encryption.noteTextIv(note.note_id), note.note_text);
    note.is_protected = false;
}

async function protectNote(note, dataKey, protect, sourceId) {
    let changed = false;

    if (protect && !note.is_protected) {
        note.note_title = data_encryption.encrypt(dataKey, data_encryption.noteTitleIv(note.note_id), note.note_title);
        note.note_text = data_encryption.encrypt(dataKey, data_encryption.noteTextIv(note.note_id), note.note_text);
        note.is_protected = true;

        changed = true;
    }
    else if (!protect && note.is_protected) {
        decryptNote(note, dataKey);

        changed = true;
    }

    if (changed) {
        console.log("Updating...");

        await sql.execute("UPDATE notes SET note_title = ?, note_text = ?, is_protected = ? WHERE note_id = ?",
            [note.note_title, note.note_text, note.is_protected, note.note_id]);

        await sync_table.addNoteSync(note.note_id, sourceId);
    }

    await protectNoteHistory(note.note_id, dataKey, protect, sourceId);
}

async function protectNoteHistory(noteId, dataKey, protect, sourceId) {
    const historyToChange = await sql.getResults("SELECT * FROM notes_history WHERE note_id = ? AND is_protected != ?", [noteId, protect]);

    for (const history of historyToChange) {
        if (protect) {
            history.note_title = data_encryption.encrypt(dataKey, data_encryption.noteTitleIv(history.note_history_id), history.note_title);
            history.note_text = data_encryption.encrypt(dataKey, data_encryption.noteTextIv(history.note_history_id), history.note_text);
            history.is_protected = true;
        }
        else {
            history.note_title = data_encryption.decryptString(dataKey, data_encryption.noteTitleIv(history.note_history_id), history.note_title);
            history.note_text = data_encryption.decryptString(dataKey, data_encryption.noteTextIv(history.note_history_id), history.note_text);
            history.is_protected = false;
        }

        await sql.execute("UPDATE notes_history SET note_title = ?, note_text = ?, is_protected = ? WHERE note_history_id = ?",
            [history.note_title, history.note_text, history.is_protected, history.note_history_id]);

        await sync_table.addNoteHistorySync(history.note_history_id, sourceId);
    }
}

async function updateNote(noteId, newNote, dataKey, sourceId) {
    if (newNote.detail.is_protected) {
        await encryptNote(newNote, dataKey);
    }

    const now = new Date();
    const nowStr = utils.nowDate();

    const historySnapshotTimeInterval = parseInt(await options.getOption('history_snapshot_time_interval'));

    const historyCutoff = utils.dateStr(new Date(now.getTime() - historySnapshotTimeInterval * 1000));

    const existingNoteHistoryId = await sql.getSingleValue(
        "SELECT note_history_id FROM notes_history WHERE note_id = ? AND date_modified_to >= ?", [noteId, historyCutoff]);

    await sql.doInTransaction(async () => {
        const msSinceDateCreated = now.getTime() - utils.parseDate(newNote.detail.date_created).getTime();

        if (!existingNoteHistoryId && msSinceDateCreated >= historySnapshotTimeInterval * 1000) {
            const oldNote = await sql.getSingleResult("SELECT * FROM notes WHERE note_id = ?", [noteId]);

            if (oldNote.is_protected) {
                decryptNote(oldNote, dataKey);
            }

            const newNoteHistoryId = utils.newNoteHistoryId();

            await sql.insert('notes_history', {
                note_history_id: newNoteHistoryId,
                note_id: noteId,
                // title and text should be decrypted now
                note_title: oldNote.note_title,
                note_text: oldNote.note_text,
                is_protected: 0, // will be fixed in the protectNoteHistory() call
                date_modified_from: oldNote.date_modified,
                date_modified_to: nowStr
            });

            await sync_table.addNoteHistorySync(newNoteHistoryId, sourceId);
        }

        await protectNoteHistory(noteId, dataKey, newNote.detail.is_protected);

        await sql.execute("UPDATE notes SET note_title = ?, note_text = ?, is_protected = ?, date_modified = ? WHERE note_id = ?", [
            newNote.detail.note_title,
            newNote.detail.note_text,
            newNote.detail.is_protected,
            nowStr,
            noteId]);

        await sync_table.addNoteSync(noteId, sourceId);
    });
}

async function deleteNote(noteTreeId, sourceId) {
    const now = utils.nowDate();

    await sql.execute("UPDATE notes_tree SET is_deleted = 1, date_modified = ? WHERE note_tree_id = ?", [now, noteTreeId]);
    await sync_table.addNoteTreeSync(noteTreeId, sourceId);

    const noteId = await sql.getSingleValue("SELECT note_id FROM notes_tree WHERE note_tree_id = ?", [noteTreeId]);

    const notDeletedNoteTreesCount = await sql.getSingleValue("SELECT COUNT(*) FROM notes_tree WHERE note_id = ? AND is_deleted = 0", [noteId]);

    if (!notDeletedNoteTreesCount) {
        await sql.execute("UPDATE notes SET is_deleted = 1, date_modified = ? WHERE note_id = ?", [now, noteId]);
        await sync_table.addNoteSync(noteId, sourceId);

        const children = await sql.getResults("SELECT note_tree_id FROM notes_tree WHERE parent_note_id = ? AND is_deleted = 0", [noteId]);

        for (const child of children) {
            await deleteNote(child.note_tree_id, sourceId);
        }
    }
}

module.exports = {
    createNewNote,
    updateNote,
    deleteNote,
    protectNoteRecursively
};