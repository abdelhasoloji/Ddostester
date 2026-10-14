import { createStore } from '../store/index.js';
import { initAuth } from '../auth/guard.js';
import { prepareSingleUser, configureAccounts } from '../auth/single-user.js';
const store = await createStore();
try {
  const auth = initAuth();
  const existing = await store.listUsers();
  const summary = {
    owner: auth.singleUserEmail,
    accounts: existing.map(({ email, role, status }) => ({ email, role, status })),
    envAccounts: [...auth.users.values()].map(({ email, role }) => ({ email, role })),
  };
  if (!process.argv.includes('--apply')) console.log(JSON.stringify({ preview: true, ...summary }));
  else {
    await prepareSingleUser(store, auth, process.env.SINGLE_USER_PASSWORD);
    await configureAccounts(store, auth);
    console.log(
      JSON.stringify({
        applied: true,
        owner: auth.singleUserEmail,
        accountCount: (await store.listUsers()).length,
      }),
    );
  }
} finally {
  await store.close();
}
