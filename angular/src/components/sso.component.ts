import { Directive } from '@angular/core';
import {
    ActivatedRoute,
    Router,
} from '@angular/router';

import { ApiService } from 'jslib-common/abstractions/api.service';
import { AuthService } from 'jslib-common/abstractions/auth.service';
import { CryptoFunctionService } from 'jslib-common/abstractions/cryptoFunction.service';
import { EnvironmentService } from 'jslib-common/abstractions/environment.service';
import { I18nService } from 'jslib-common/abstractions/i18n.service';
import { PasswordGenerationService } from 'jslib-common/abstractions/passwordGeneration.service';
import { PlatformUtilsService } from 'jslib-common/abstractions/platformUtils.service';
import { StateService } from 'jslib-common/abstractions/state.service';
import { StorageService } from 'jslib-common/abstractions/storage.service';

import { ConstantsService } from 'jslib-common/services/constants.service';

import { Utils } from 'jslib-common/misc/utils';

import { AuthResult } from 'jslib-common/models/domain/authResult';

import { switchMap } from 'rxjs/operators';

@Directive()
export class SsoComponent {
    identifier: string;
    loggingIn = false;

    formPromise: Promise<AuthResult>;
    initiateSsoFormPromise: Promise<any>;
    onSuccessfulLogin: () => Promise<any>;
    onSuccessfulLoginNavigate: () => Promise<any>;
    onSuccessfulLoginTwoFactorNavigate: () => Promise<any>;
    onSuccessfulLoginChangePasswordNavigate: () => Promise<any>;
    onSuccessfulLoginForceResetNavigate: () => Promise<any>;

    protected twoFactorRoute = '2fa';
    protected successRoute = 'lock';
    protected changePasswordRoute = 'set-password';
    protected forcePasswordResetRoute = 'update-temp-password';
    protected clientId: string;
    protected redirectUri: string;
    protected state: string;
    protected codeChallenge: string;

    constructor(protected authService: AuthService, protected router: Router,
        protected i18nService: I18nService, protected route: ActivatedRoute,
        protected storageService: StorageService, protected stateService: StateService,
        protected platformUtilsService: PlatformUtilsService, protected apiService: ApiService,
        protected cryptoFunctionService: CryptoFunctionService, protected environmentService: EnvironmentService,
        protected passwordGenerationService: PasswordGenerationService) { }

    async ngOnInit() {
        const queryParamsSub = this.route.queryParams.subscribe(async qParams => {

		// I have no idea why the qParams is empty here - I've hacked in an
		// alternative very messily, but it works.
            const workingParams = (new URL(window.location.href)).searchParams;
            const workingSwap = {
                code: workingParams.get('code'),
                state: workingParams.get('state'),
            };

			console.log("jslib/angular/src/components/sso.component.ts")
			console.log(workingParams);

            if (workingSwap.code != null && workingSwap.state != null) {
			console.log("if 1");
                const codeVerifier = await this.storageService.get<string>(ConstantsService.ssoCodeVerifierKey);
                const state = await this.storageService.get<string>(ConstantsService.ssoStateKey);
                await this.storageService.remove(ConstantsService.ssoCodeVerifierKey);
                await this.storageService.remove(ConstantsService.ssoStateKey);
                if (workingSwap.code != null && codeVerifier != null && state != null && this.checkState(state, workingSwap.state)) {
					console.log("this.login");
                    await this.logIn(workingSwap.code, codeVerifier, this.getOrgIdentiferFromState(workingSwap.state));
                }
            } else if (qParams.clientId != null && qParams.redirectUri != null && qParams.state != null &&
                qParams.codeChallenge != null) {
				console.log("else 1");
                this.redirectUri = qParams.redirectUri;
                this.state = qParams.state;
                this.codeChallenge = qParams.codeChallenge;
                this.clientId = qParams.clientId;
            }
            if (queryParamsSub != null) {
			console.log("if 2");
                queryParamsSub.unsubscribe();
            }
        });
    }

    async submit(returnUri?: string, includeUserIdentifier?: boolean) {
        this.initiateSsoFormPromise = this.preValidate();
        if (await this.initiateSsoFormPromise) {
            const authorizeUrl = await this.buildAuthorizeUrl(returnUri, includeUserIdentifier);
            this.platformUtilsService.launchUri(authorizeUrl, { sameWindow: true });
        }
    }

    async preValidate(): Promise<boolean> {
        if (this.identifier == null || this.identifier === '') {
            this.platformUtilsService.showToast('error', this.i18nService.t('ssoValidationFailed'),
                this.i18nService.t('ssoIdentifierRequired'));
            return false;
        }
        return await this.apiService.preValidateSso(this.identifier);
    }

    protected async buildAuthorizeUrl(returnUri?: string, includeUserIdentifier?: boolean): Promise<string> {
        let codeChallenge = this.codeChallenge;
        let state = this.state;

        const passwordOptions: any = {
            type: 'password',
            length: 64,
            uppercase: true,
            lowercase: true,
            numbers: true,
            special: false,
        };

        if (codeChallenge == null) {
            const codeVerifier = await this.passwordGenerationService.generatePassword(passwordOptions);
            const codeVerifierHash = await this.cryptoFunctionService.hash(codeVerifier, 'sha256');
            codeChallenge = Utils.fromBufferToUrlB64(codeVerifierHash);
            await this.storageService.save(ConstantsService.ssoCodeVerifierKey, codeVerifier);
        }

        if (state == null) {
            state = await this.passwordGenerationService.generatePassword(passwordOptions);
            if (returnUri) {
                state += `_returnUri='${returnUri}'`;
            }
        }

        // Add Organization Identifier to state
        state += `_identifier=${this.identifier}`;

        // Save state (regardless of new or existing)
        await this.storageService.save(ConstantsService.ssoStateKey, state);

        let authorizeUrl = this.environmentService.getIdentityUrl() + '/connect/authorize?' +
            'client_id=' + this.clientId + '&redirect_uri=' + encodeURIComponent(this.redirectUri) + '&' +
            'response_type=code&scope=api offline_access&' +
            'state=' + encodeURIComponent(state) + '&code_challenge=' + codeChallenge + '&' +
            'code_challenge_method=S256&response_mode=query&' +
            'domain_hint=' + encodeURIComponent(this.identifier);

        if (includeUserIdentifier) {
            const userIdentifier = await this.apiService.getSsoUserIdentifier();
            authorizeUrl += `&user_identifier=${encodeURIComponent(userIdentifier)}`;
        }

        return authorizeUrl;
    }

    private async logIn(code: string, codeVerifier: string, orgIdFromState: string) {

		console.log("redirect url: " + this.redirectUri);

        this.loggingIn = true;
        try {
		console.log("sso.component.login.try");
            this.formPromise = this.authService.logInSso(code, codeVerifier, this.redirectUri, orgIdFromState);
		console.log("sso.component.login.try1");
            const response = await this.formPromise;
		console.log("sso.component.login.try2");
            if (response.twoFactor) {
                if (this.onSuccessfulLoginTwoFactorNavigate != null) {
                    this.onSuccessfulLoginTwoFactorNavigate();
                } else {
                    this.router.navigate([this.twoFactorRoute], {
                        queryParams: {
                            identifier: orgIdFromState,
                            sso: 'true',
                        },
                    });
                }
            } else if (response.resetMasterPassword) {
                if (this.onSuccessfulLoginChangePasswordNavigate != null) {
                    this.onSuccessfulLoginChangePasswordNavigate();
                } else {
                    this.router.navigate([this.changePasswordRoute], {
                        queryParams: {
                            identifier: orgIdFromState,
                        },
                    });
                }
            } else if (response.forcePasswordReset) {
                if (this.onSuccessfulLoginForceResetNavigate != null) {
                    this.onSuccessfulLoginForceResetNavigate();
                } else {
                    this.router.navigate([this.forcePasswordResetRoute]);
                }
            } else {

		console.log("sso.component.else");
                const disableFavicon = await this.storageService.get<boolean>(ConstantsService.disableFaviconKey);
                await this.stateService.save(ConstantsService.disableFaviconKey, !!disableFavicon);
                if (this.onSuccessfulLogin != null) {
		console.log("sso.component.else.if1");
                    this.onSuccessfulLogin();
                }
                if (this.onSuccessfulLoginNavigate != null) {
		console.log("sso.component.else.if2");
                    this.onSuccessfulLoginNavigate();
                } else {
		console.log("sso.component.else.else");
                    this.router.navigate([this.successRoute]);
                }
            }
        } catch { 

		console.log("sso.component.login.catch");
		}

		console.log("sso.componentloggingIN=false");
        this.loggingIn = false;
    }

    private getOrgIdentiferFromState(state: string): string {
        if (state === null || state === undefined) {
            return null;
        }

        const stateSplit = state.split('_identifier=');
        return stateSplit.length > 1 ? stateSplit[1] : null;
    }

    private checkState(state: string, checkState: string): boolean {
        if (state === null || state === undefined) {
            return false;
        }
        if (checkState === null || checkState === undefined) {
            return false;
        }

        const stateSplit = state.split('_identifier=');
        const checkStateSplit = checkState.split('_identifier=');
        return stateSplit[0] === checkStateSplit[0];
    }
}
