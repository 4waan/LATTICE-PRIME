export class PrivateSessionControllerError extends Error {
    constructor(code, status = 400) {
        super("private session request failed");
        this.name = "PrivateSessionControllerError";
        this.code = code;
        this.status = status;
    }
}

function fail(code, status = 400) {
    throw new PrivateSessionControllerError(code, status);
}

export class PrivateSessionController {
    constructor({registrationController, recoveryController}) {
        if (
            typeof registrationController?.handle !== "function"
            || typeof recoveryController?.handle !== "function"
        ) {
            fail("SESSION_CONTROLLER_CONFIG_INVALID", 500);
        }
        this.registrationController = registrationController;
        this.recoveryController = recoveryController;
    }

    async handle(body) {
        if (
            body === null
            || typeof body !== "object"
            || Array.isArray(body)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(body))
            || typeof body.action !== "string"
        ) {
            fail("SESSION_REQUEST_SCHEMA_INVALID");
        }
        if (["deploy-and-register", "register"].includes(body.action)) {
            return this.registrationController.handle(body);
        }
        if (body.action === "recover-to-router") {
            return this.recoveryController.handle(body);
        }
        fail("SESSION_ACTION_INVALID");
    }
}
