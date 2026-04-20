const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const cors = require('cors')({ origin: true });

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

// Initialize Plaid Client
const configuration = new Configuration({
  basePath: PlaidEnvironments.production,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(configuration);

// ========== PLAID LINK TOKEN ==========
// Called by frontend to get a Link token for Plaid's popup
exports.createPlaidLinkToken = functions.https.onCall(async (data, context) => {
  try {
    // Verify user is authenticated
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = context.auth.uid;
    const request = {
      user: { client_user_id: userId },
      client_name: 'Family Finance App',
      products: ['auth', 'transactions'],
      language: 'en',
      country_codes: ['US'],
    };

    const response = await plaidClient.linkTokenCreate(request);
    return {
      link_token: response.data.link_token,
      expiration: response.data.expiration,
    };
  } catch (error) {
    console.error('Error creating link token:', error);
    throw new functions.https.HttpsError('internal', 'Failed to create link token');
  }
});

// ========== EXCHANGE PUBLIC TOKEN ==========
// Called after user connects bank account in Plaid Link
exports.exchangePublicToken = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = context.auth.uid;
    const publicToken = data.public_token;

    if (!publicToken) {
      throw new functions.https.HttpsError('invalid-argument', 'public_token is required');
    }

    // Exchange public token for access token
    const exchangeRequest = {
      public_token: publicToken,
    };

    const exchangeResponse = await plaidClient.itemPublicTokenExchange(exchangeRequest);
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;

    // Get bank account info
    const accountsRequest = {
      access_token: accessToken,
    };

    const accountsResponse = await plaidClient.accountsGet(accountsRequest);
    const accounts = accountsResponse.data.accounts;
    const institution = accountsResponse.data.institution;

    // Save to Firestore (never expose access token to frontend!)
    await db.collection('users').doc(userId).collection('bankAccounts').doc(itemId).set({
      accessToken,
      itemId,
      institution: {
        id: institution.institution_id,
        name: institution.name,
      },
      accounts: accounts.map(acc => ({
        accountId: acc.account_id,
        name: acc.name,
        type: acc.type,
        subtype: acc.subtype,
        mask: acc.mask,
      })),
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      itemId,
      message: 'Bank account connected successfully',
    };
  } catch (error) {
    console.error('Error exchanging token:', error);
    throw new functions.https.HttpsError('internal', 'Failed to connect bank account');
  }
});

// ========== SYNC TRANSACTIONS ==========
// Called to fetch and sync transactions from connected banks
exports.syncTransactions = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = context.auth.uid;
    const itemId = data.itemId;

    if (!itemId) {
      throw new functions.https.HttpsError('invalid-argument', 'itemId is required');
    }

    // Get the access token from Firestore
    const bankAccountDoc = await db
      .collection('users')
      .doc(userId)
      .collection('bankAccounts')
      .doc(itemId)
      .get();

    if (!bankAccountDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Bank account not found');
    }

    const accessToken = bankAccountDoc.data().accessToken;

    // Fetch transactions from last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const transactionsRequest = {
      access_token: accessToken,
      start_date: thirtyDaysAgo.toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0],
    };

    const transactionsResponse = await plaidClient.transactionsGet(transactionsRequest);
    const transactions = transactionsResponse.data.transactions;

    // Save transactions to Firestore
    const batch = db.batch();
    transactions.forEach(tx => {
      const txRef = db
        .collection('users')
        .doc(userId)
        .collection('transactions')
        .doc(tx.transaction_id);

      batch.set(txRef, {
        transactionId: tx.transaction_id,
        itemId,
        accountId: tx.account_id,
        amount: tx.amount,
        currency: tx.iso_currency_code,
        date: tx.date,
        name: tx.name,
        merchant: tx.merchant_name,
        category: tx.personal_finance_category?.primary || 'Other',
        pending: tx.pending,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    await batch.commit();

    // Update bank account sync timestamp
    await db
      .collection('users')
      .doc(userId)
      .collection('bankAccounts')
      .doc(itemId)
      .update({
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastTransactionCount: transactions.length,
      });

    return {
      success: true,
      transactionCount: transactions.length,
      message: `Synced ${transactions.length} transactions`,
    };
  } catch (error) {
    console.error('Error syncing transactions:', error);
    throw new functions.https.HttpsError('internal', 'Failed to sync transactions');
  }
});

// ========== GET CONNECTED BANKS ==========
// Called to fetch list of user's connected bank accounts
exports.getConnectedBanks = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = context.auth.uid;

    const snapshot = await db
      .collection('users')
      .doc(userId)
      .collection('bankAccounts')
      .get();

    const banks = snapshot.docs.map(doc => ({
      itemId: doc.id,
      ...doc.data(),
      // NEVER expose access token to frontend
      accessToken: undefined,
    }));

    return { banks };
  } catch (error) {
    console.error('Error fetching connected banks:', error);
    throw new functions.https.HttpsError('internal', 'Failed to fetch connected banks');
  }
});

// ========== DISCONNECT BANK ==========
// Called when user wants to remove a bank connection
exports.disconnectBank = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = context.auth.uid;
    const itemId = data.itemId;

    if (!itemId) {
      throw new functions.https.HttpsError('invalid-argument', 'itemId is required');
    }

    // Delete bank account and its transactions
    const bankAccountRef = db
      .collection('users')
      .doc(userId)
      .collection('bankAccounts')
      .doc(itemId);

    // Delete all transactions from this bank
    const txsSnapshot = await db
      .collection('users')
      .doc(userId)
      .collection('transactions')
      .where('itemId', '==', itemId)
      .get();

    const batch = db.batch();
    txsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(bankAccountRef);
    await batch.commit();

    return { success: true, message: 'Bank account disconnected' };
  } catch (error) {
    console.error('Error disconnecting bank:', error);
    throw new functions.https.HttpsError('internal', 'Failed to disconnect bank');
  }
});

// ========== HEALTH CHECK ==========
exports.health = functions.https.onRequest((req, res) => {
  cors(req, res, () => {
    res.json({ status: 'ok', message: 'Family Finance API is running' });
  });
});
