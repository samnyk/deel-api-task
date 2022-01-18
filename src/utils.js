const moment = require('moment')


const validateDate = function (date) {
    return moment(date, ['MM-DD-YYYY'], true).isValid()
}
module.exports = { validateDate }