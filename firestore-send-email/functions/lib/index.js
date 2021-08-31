"use strict";
/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.processQueue = void 0;
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const nodemailer = require("nodemailer");
const logs = require("./logs");
const config_1 = require("./config");
const templates_1 = require("./templates");
logs.init();
let db;
let transport;
let templates;
let initialized = false;
/**
 * Initializes Admin SDK & SMTP connection if not already initialized.
 */
async function initialize() {
    if (initialized === true)
        return;
    initialized = true;
    admin.initializeApp();
    db = admin.firestore();
    transport = await transportLayer();
    if (config_1.default.templatesCollection) {
        templates = new templates_1.default(admin.firestore().collection(config_1.default.templatesCollection));
    }
}
async function transportLayer() {
    if (config_1.default.testing) {
        return new Promise((resolve, reject) => {
            nodemailer.createTestAccount((err, account) => {
                if (err) {
                    reject(err);
                }
                const testSMTPCredentials = nodemailer.createTransport({
                    host: "smtp.ethereal.email",
                    port: 587,
                    secure: false,
                    auth: {
                        user: account.user,
                        pass: account.pass,
                    },
                });
                resolve(testSMTPCredentials);
            });
        });
    }
    else {
        return nodemailer.createTransport(config_1.default.smtpConnectionUri);
    }
}
function validateFieldArray(field, array) {
    if (!Array.isArray(array)) {
        throw new Error(`Invalid field "${field}". Expected an array of strings.`);
    }
    if (array.find((item) => typeof item !== "string")) {
        throw new Error(`Invalid field "${field}". Expected an array of strings.`);
    }
}
async function processCreate(snap) {
    // Wrapping in transaction to allow for automatic retries (#48)
    return admin.firestore().runTransaction((transaction) => {
        transaction.update(snap.ref, {
            delivery: {
                startTime: admin.firestore.FieldValue.serverTimestamp(),
                state: "PENDING",
                attempts: 0,
                error: null,
            },
        });
        return Promise.resolve();
    });
}
async function preparePayload(payload) {
    const { template } = payload;
    if (templates && template) {
        if (!template.name) {
            throw new Error(`Template object is missing a 'name' parameter.`);
        }
        payload.message = Object.assign(payload.message || {}, await templates.render(template.name, template.data));
    }
    let to = [];
    let cc = [];
    let bcc = [];
    if (typeof payload.to === "string") {
        to = [payload.to];
    }
    else if (payload.to) {
        validateFieldArray("to", payload.to);
        to = to.concat(payload.to);
    }
    if (typeof payload.cc === "string") {
        cc = [payload.cc];
    }
    else if (payload.cc) {
        validateFieldArray("cc", payload.cc);
        cc = cc.concat(payload.cc);
    }
    if (typeof payload.bcc === "string") {
        bcc = [payload.bcc];
    }
    else if (payload.bcc) {
        validateFieldArray("bcc", payload.bcc);
        bcc = bcc.concat(payload.bcc);
    }
    if (!payload.toUids && !payload.ccUids && !payload.bccUids) {
        payload.to = to;
        payload.cc = cc;
        payload.bcc = bcc;
        return payload;
    }
    if (!config_1.default.usersCollection) {
        throw new Error("Must specify a users collection to send using uids.");
    }
    let uids = [];
    if (payload.toUids) {
        validateFieldArray("toUids", payload.toUids);
        uids = uids.concat(payload.toUids);
    }
    if (payload.ccUids) {
        validateFieldArray("ccUids", payload.ccUids);
        uids = uids.concat(payload.ccUids);
    }
    if (payload.bccUids) {
        validateFieldArray("bccUids", payload.bccUids);
        uids = uids.concat(payload.bccUids);
    }
    const toFetch = {};
    uids.forEach((uid) => (toFetch[uid] = null));
    const documents = await db.getAll(...Object.keys(toFetch).map((uid) => db.collection(config_1.default.usersCollection).doc(uid)), {
        fieldMask: ["email"],
    });
    const missingUids = [];
    documents.forEach((documentSnapshot) => {
        if (documentSnapshot.exists) {
            const email = documentSnapshot.get("email");
            if (email) {
                toFetch[documentSnapshot.id] = email;
            }
            else {
                missingUids.push(documentSnapshot.id);
            }
        }
        else {
            missingUids.push(documentSnapshot.id);
        }
    });
    logs.missingUids(missingUids);
    if (payload.toUids) {
        payload.toUids.forEach((uid) => {
            const email = toFetch[uid];
            if (email) {
                to.push(email);
            }
        });
    }
    payload.to = to;
    if (payload.ccUids) {
        payload.ccUids.forEach((uid) => {
            const email = toFetch[uid];
            if (email) {
                cc.push(email);
            }
        });
    }
    payload.cc = cc;
    if (payload.bccUids) {
        payload.bccUids.forEach((uid) => {
            const email = toFetch[uid];
            if (email) {
                bcc.push(email);
            }
        });
    }
    payload.bcc = bcc;
    return payload;
}
async function deliver(payload, ref) {
    logs.attemptingDelivery(ref);
    const update = {
        "delivery.attempts": admin.firestore.FieldValue.increment(1),
        "delivery.endTime": admin.firestore.FieldValue.serverTimestamp(),
        "delivery.error": null,
        "delivery.leaseExpireTime": null,
    };
    try {
        payload = await preparePayload(payload);
        if (!payload.to.length && !payload.cc.length && !payload.bcc.length) {
            throw new Error("Failed to deliver email. Expected at least 1 recipient.");
        }
        const result = await transport.sendMail(Object.assign(payload.message, {
            from: payload.from || config_1.default.defaultFrom,
            replyTo: payload.replyTo || config_1.default.defaultReplyTo,
            to: payload.to,
            cc: payload.cc,
            bcc: payload.bcc,
            headers: payload.headers || {},
        }));
        const info = {
            messageId: result.messageId || null,
            accepted: result.accepted || [],
            rejected: result.rejected || [],
            pending: result.pending || [],
            response: result.response || null,
        };
        update["delivery.state"] = "SUCCESS";
        update["delivery.info"] = info;
        logs.delivered(ref, info);
    }
    catch (e) {
        update["delivery.state"] = "ERROR";
        update["delivery.error"] = e.toString();
        logs.deliveryError(ref, e);
    }
    // Wrapping in transaction to allow for automatic retries (#48)
    return admin.firestore().runTransaction((transaction) => {
        transaction.update(ref, update);
        return Promise.resolve();
    });
}
async function processWrite(change) {
    if (!change.after.exists) {
        return null;
    }
    if (!change.before.exists && change.after.exists) {
        return processCreate(change.after);
    }
    const payload = change.after.data();
    if (!payload.delivery) {
        logs.missingDeliveryField(change.after.ref);
        return null;
    }
    switch (payload.delivery.state) {
        case "SUCCESS":
        case "ERROR":
            return null;
        case "PROCESSING":
            if (payload.delivery.leaseExpireTime.toMillis() < Date.now()) {
                // Wrapping in transaction to allow for automatic retries (#48)
                return admin.firestore().runTransaction((transaction) => {
                    transaction.update(change.after.ref, {
                        "delivery.state": "ERROR",
                        error: "Message processing lease expired.",
                    });
                    return Promise.resolve();
                });
            }
            return null;
        case "PENDING":
        case "RETRY":
            // Wrapping in transaction to allow for automatic retries (#48)
            await admin.firestore().runTransaction((transaction) => {
                transaction.update(change.after.ref, {
                    "delivery.state": "PROCESSING",
                    "delivery.leaseExpireTime": admin.firestore.Timestamp.fromMillis(Date.now() + 60000),
                });
                return Promise.resolve();
            });
            return deliver(payload, change.after.ref);
    }
}
exports.processQueue = functions.handler.firestore.document.onWrite(async (change) => {
    await initialize();
    logs.start();
    try {
        await processWrite(change);
    }
    catch (err) {
        logs.error(err);
        return null;
    }
    logs.complete();
});
