"use strict";

const crypto = require("crypto");
const { HttpsError } = require("firebase-functions/v2/https");

const EMAIL_DOMAIN = "connect.experiencecalgary.ca";
const ADDRESS_COLLECTION = "commandEmailAddresses";
const ALIAS_COLLECTION = "commandEmailAliases";
const REPLY_TOKEN_COLLECTION = "commandEmailReplyTokens";

function compactSenderLocalPart(actor = {}) {
  const user = actor.userData || {};
  const suppliedFirst = String(user.firstName || '').trim();
  const suppliedLast = String(user.lastName || '').trim();
  const nameParts = String(actor.name || '').trim().split(/\s+/).filter(Boolean);
  const firstName = suppliedFirst || nameParts[0] || '';
  const lastName = suppliedLast ||
    (nameParts.length > 1 ? nameParts[nameParts.length - 1] : '');
  const initials = `${firstName.slice(0, 1)}${lastName.slice(0, 1)}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const repId = String(actor.repId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (!initials || !repId) {
    throw new HttpsError(
      'failed-precondition',
      'A short ExMail address requires a representative name and repId.'
    );
  }
  return `${initials}${repId}`.slice(0, 60);
}

async function allocateSenderAddress(db, admin, actor) {
  const addressRef = db.collection(ADDRESS_COLLECTION).doc(actor.uid);
  const desiredLocalPart = compactSenderLocalPart(actor);
  const desiredAddress = `${desiredLocalPart}@${EMAIL_DOMAIN}`;
  const desiredAliasRef = db.collection(ALIAS_COLLECTION).doc(desiredLocalPart);

  return db.runTransaction(async (transaction) => {
    const currentAddressSnapshot = await transaction.get(addressRef);
    const current = currentAddressSnapshot.exists
      ? currentAddressSnapshot.data() || {}
      : {};
    const currentAddress = String(current.address || '').trim().toLowerCase();
    const currentLocalPart = currentAddress.split('@')[0] || '';
    const userAddress = String(actor.userData?.commandEmailAddress || '')
      .trim()
      .toLowerCase();

    if (userAddress && currentAddress && userAddress !== currentAddress) {
      throw new HttpsError(
        'failed-precondition',
        'Your ExMail address configuration is out of sync. Contact an administrator.'
      );
    }

    const aliasRefs = [desiredAliasRef];
    if (currentLocalPart && currentLocalPart !== desiredLocalPart) {
      aliasRefs.push(db.collection(ALIAS_COLLECTION).doc(currentLocalPart));
    }
    const aliasSnapshots = await transaction.getAll(...aliasRefs);
    const desiredAlias = aliasSnapshots[0];
    if (desiredAlias.exists && desiredAlias.data()?.uid !== actor.uid) {
      throw new HttpsError(
        'already-exists',
        'The short ExMail address is already assigned to another representative.'
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    transaction.set(desiredAliasRef, {
      uid: actor.uid,
      userRef: actor.userRef,
      repId: actor.repId,
      address: desiredAddress,
      active: true,
      createdAt: desiredAlias.exists
        ? desiredAlias.data()?.createdAt || now
        : now,
      updatedAt: now,
    }, { merge: true });

    if (currentLocalPart && currentLocalPart !== desiredLocalPart) {
      const legacyAliasRef = aliasRefs[1];
      const legacyAlias = aliasSnapshots[1];
      if (legacyAlias.exists && legacyAlias.data()?.uid !== actor.uid) {
        throw new HttpsError(
          'failed-precondition',
          'The existing ExMail alias belongs to another representative.'
        );
      }
      transaction.set(legacyAliasRef, {
        uid: actor.uid,
        userRef: actor.userRef,
        repId: actor.repId,
        address: currentAddress,
        active: true,
        legacy: true,
        replacedByAddress: desiredAddress,
        createdAt: legacyAlias.exists
          ? legacyAlias.data()?.createdAt || now
          : now,
        updatedAt: now,
      }, { merge: true });
    }

    const legacyAddresses = Array.isArray(current.legacyAddresses)
      ? current.legacyAddresses.map((value) => String(value || '').toLowerCase())
      : [];
    if (currentAddress && currentAddress !== desiredAddress) {
      legacyAddresses.push(currentAddress);
    }

    transaction.set(addressRef, {
      uid: actor.uid,
      userRef: actor.userRef,
      repId: actor.repId,
      senderName: actor.name,
      localPart: desiredLocalPart,
      address: desiredAddress,
      legacyAddresses: [...new Set(legacyAddresses.filter(Boolean))],
      active: true,
      createdAt: current.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    transaction.set(actor.userRef, {
      commandEmailAddress: desiredAddress,
      commandEmailAddressUpdatedAt: now,
    }, { merge: true });

    return desiredAddress;
  });
}

async function createReplyAddress(db, admin, threadRef) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenRef = db.collection(REPLY_TOKEN_COLLECTION).doc(token);

  await tokenRef.create({
    threadRef,
    threadId: threadRef.id,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return `reply+${token}@${EMAIL_DOMAIN}`;
}

module.exports = {
  EMAIL_DOMAIN,
  compactSenderLocalPart,
  allocateSenderAddress,
  createReplyAddress,
};
