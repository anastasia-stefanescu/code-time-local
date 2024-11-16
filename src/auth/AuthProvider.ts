import {
  authentication, AuthenticationProvider, AuthenticationProviderAuthenticationSessionsChangeEvent,
  AuthenticationSession, Disposable, Event, env, EventEmitter, ExtensionContext, ProgressLocation,
  Uri, UriHandler, window
} from "vscode";
import { v4 as uuid } from 'uuid';
import { app_url } from "../Constants";
import { getAuthQueryObject, getBooleanItem, logIt, setItem } from "../Util";
import { authenticationCompleteHandler, getUser } from "../DataController";

export const AUTH_TYPE = 'codetime_auth';
const AUTH_NAME = 'Software.com';
const SESSIONS_KEY = `${AUTH_TYPE}.sessions`

let instance: AuthProvider;

export function getAuthInstance(): AuthProvider {
  if (!instance) {
    logIt('AuthenticationProvider not initialized');
  }
  return instance;
}

class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
  public handleUri(uri: Uri) {
    this.fire(uri);
  }
}


export class AuthProvider implements AuthenticationProvider, Disposable {
  private _sessionChangeEmitter = new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private _disposable: Disposable;
  private _pendingStates: string[] = [];
  private _codeExchangePromises = new Map<string, { promise: Promise<string>; cancel: EventEmitter<void> }>();
  private _uriHandler = new UriEventHandler();

  constructor(private readonly context: ExtensionContext) {
    this._disposable = Disposable.from(
      authentication.registerAuthenticationProvider(AUTH_TYPE, AUTH_NAME, this, { supportsMultipleAccounts: false }),
      window.registerUriHandler(this._uriHandler)
    )
    instance = this;
  }

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  get redirectUri() {
    const publisher = this.context.extension.packageJSON.publisher;
    const name = this.context.extension.packageJSON.name;
    return `${env.uriScheme}://${publisher}.${name}`;
  }


  //Session Management section (getSessions, createSession, updateSession, removeSession):
  // - unique jwtToken
  // - stores sessions in context.secrets
  // - New sessions can be created, existing sessions updated, and sessions removed
  // - _sessionChangeEmitter notifies VS Code of any session changes so the UI can update.
  //here, I changed the returned Promise so it's not readonly anymore
  public async getSessions(scopes?: string[]): Promise<AuthenticationSession[]> {
    const allSessions = await this.context.secrets.get(SESSIONS_KEY);

    if (allSessions) {
      return JSON.parse(allSessions) as AuthenticationSession[];
    }

    return [];
  }

  public async updateSession(jwtToken: string, user: any = null): Promise<AuthenticationSession> {
    let session: AuthenticationSession = {
      id: uuid(),
      accessToken: jwtToken,
      account: {
        label: '',
        id: ''
      },
      scopes: []
    }
    try {
      const sessionUpdate = !!user
      if (!user) {
        user = await getUser(jwtToken);
        await authenticationCompleteHandler(user, jwtToken);
      }

      session = {
        id: uuid(),
        accessToken: jwtToken,
        account: {
          label: user.email,
          id: user.id
        },
        scopes: []
      };

      await this.context.secrets.store(SESSIONS_KEY, JSON.stringify([session]))

      if (sessionUpdate) {
        this._sessionChangeEmitter.fire({ added: [], removed: [], changed: [session] });
      } else {
        this._sessionChangeEmitter.fire({ added: [session], removed: [], changed: [] });
      }
    } catch (e: any) {
      if (e.message) {
        logIt(`Error creating session: ${e?.message}`);
      }
    }
    return session;
  }

  /**
   * Create a new auth session
   * @param scopes 
   * @returns 
   */
  public async createSession(scopes: string[]): Promise<AuthenticationSession> {
    const jwtToken = await this.login(scopes);
    if (!jwtToken) {
      throw new Error(`Software.com login failure`);
    }
    return this.updateSession(jwtToken);
  }

  /**
   * Remove an existing session
   * @param sessionId 
   */
  public async removeSession(sessionId: string): Promise<void> {
    const allSessions = await this.context.secrets.get(SESSIONS_KEY);
    if (allSessions) {
      let sessions = JSON.parse(allSessions) as AuthenticationSession[];
      const sessionIdx = sessions.findIndex(s => s.id === sessionId);
      const session = sessions[sessionIdx];
      sessions.splice(sessionIdx, 1);

      await this.context.secrets.store(SESSIONS_KEY, JSON.stringify(sessions));

      if (session) {
        this._sessionChangeEmitter.fire({ added: [], removed: [session], changed: [] });
      }
    }
  }
  // End of SEssion Management Section

  //Dispose the registered services
  public async dispose() {
    this._disposable.dispose();
  }

  //USER LOGIN SECTION (login, promiseFromEvent, handleUri, redirectUri)
  // - login method initiates OAuth-based login flow, typically opening a login page in external browser where the user authenticates
  // - After login, the OAuth provider redirects the user back to a specific VS Code URI (set by  redirectUri method).
  // - handleUri captures the access token from this redirect and completes the authentication process.
  private async login(scopes: string[] = []) {
    return await window.withProgress<string>({  
      location: ProgressLocation.Notification,
      title: "Signing in to Software.com...",
      cancellable: true
    }, async (_, token) => {
      setItem('logging_in', true);
      const stateId = uuid();

      this._pendingStates.push(stateId);

      const scopeString = scopes.join(' ');
      let params: URLSearchParams = getAuthQueryObject();
      params.append('response_type', 'token');
      params.append('redirect_uri', this.redirectUri);
      params.append('state', stateId);
      params.append('prompt', 'login');
      const uri = Uri.parse(`${app_url}/plugin/authorize?${params.toString()}`);
      await env.openExternal(uri);

      let codeExchangePromise = this._codeExchangePromises.get(scopeString);
      if (!codeExchangePromise) {
        codeExchangePromise = promiseFromEvent(this._uriHandler.event, this.handleUri(scopes));
        this._codeExchangePromises.set(scopeString, codeExchangePromise);
      }

      try {
        return await Promise.race([
          codeExchangePromise.promise,
          // 2 minute timeout
          new Promise<string>((_, reject) => setTimeout(() => reject('Cancelled'), 120000)),
          // websocket login check
          new Promise<string>((_, reject) => {
            const interval = setInterval(async () => {
              if (getBooleanItem('logging_in') === false) {
                clearInterval(interval);
                reject('Cancelled');
              }
            }, 1500);
          }),
          // cancel button
          promiseFromEvent<any, any>(token.onCancellationRequested, (_, __, reject) => { reject('Login Cancelled'); }).promise
        ]);
      } finally {
        this._pendingStates = this._pendingStates.filter(n => n !== stateId);
        codeExchangePromise?.cancel.fire();
        this._codeExchangePromises.delete(scopeString);
        // reset logging_in flag
        setItem('logging_in', false);
      }
    });
  }

  /**
   * Handle the redirect to VS Code (after sign in from Auth0)
   * @param scopes 
   * @returns 
   */
  private handleUri: (scopes: readonly string[]) => PromiseAdapter<Uri, string> =
    (scopes) => async (uri, resolve, reject) => {
      const query = new URLSearchParams(uri.query);
      const access_token = query.get('access_token');
      const state = query.get('state');

      if (!access_token) {
        reject(new Error('Authentication token not found'));
        return;
      }
      if (!state) {
        reject(new Error('Authentication state not found'));
        return;
      }

      // Check if it is a valid auth request started by the extension
      if (!this._pendingStates.some(n => n === state)) {
        reject(new Error('Authentication state not found'));
        return;
      }

      resolve(access_token);
    }
}

// End of USER LOGIN SECTION
// End of AuthProvider CLASS

export interface PromiseAdapter<T, U> {
  (
    value: T,
    resolve:
      (value: U | PromiseLike<U>) => void,
    reject:
      (reason: any) => void
  ): any;
}


// Event Handling Section  (promiseFromEvent, handleUri):

// - (promiseFromEvent) listens for specific events (e.g., URI redirection or login timeout)
//   and returns a promise that resolves or rejects based on the event outcome.

// - (handleUri) specifically deals with the URI redirection. It extracts the access_token from 
//   the redirect URI and verifies it against the expected state, ensuring a secure login process.
const passthrough = (value: any, resolve: (value?: any) => void) => resolve(value);

/**
 * Return a promise that resolves with the next emitted event, or with some future
 * event as decided by an adapter.
 *
 * If specified, the adapter is a function that will be called with
 * `(event, resolve, reject)`. It will be called once per event until it resolves or
 * rejects.
 *
 * The default adapter is the passthrough function `(value, resolve) => resolve(value)`.
 *
 * @param event the event
 * @param adapter controls resolution of the returned promise
 * @returns a promise that resolves or rejects as specified by the adapter
 */
export function promiseFromEvent<T, U>(event: Event<T>, adapter: PromiseAdapter<T, U> = passthrough): { promise: Promise<U>; cancel: EventEmitter<void> } {
  let subscription: Disposable;
  let cancel = new EventEmitter<void>();

  return {
    promise: new Promise<U>((resolve, reject) => {
      cancel.event(_ => reject('Cancelled'));
      subscription = event((value: T) => {
        try {
          Promise.resolve(adapter(value, resolve, reject))
            .catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    }).then(
      (result: U) => {
        subscription.dispose();
        return result;
      },
      error => {
        subscription.dispose();
        throw error;
      }
    ),
    cancel
  };
}

