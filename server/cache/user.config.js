const ADMIN = 'admin'
const OWNER = 'owner';
const ADMIN_ROLE = 'platform-admin';

function ownerToGlobalRole (role) {
	if (role === ADMIN || role === OWNER) {
		return ADMIN_ROLE;
	}
	return role;
};

module.exports = {
	ADMIN,
    OWNER,
    ADMIN_ROLE,
    ownerToGlobalRole
};