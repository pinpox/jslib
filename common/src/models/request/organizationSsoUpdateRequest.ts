export class OrganizationSsoUpdateRequest {
    useSso: boolean;
    callbackPath: string;
    signedOutCallbackPath: string;
    authority: string;
    clientId: string;
    clientSecret: string;
}
