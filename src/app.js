const express = require('express');
const bodyParser = require('body-parser');
const { sequelize, Contract, Job, Profile } = require('./model')
const { Op, BaseError } = require("sequelize");
const { getProfile } = require('./middleware/getProfile');
const { roleValidation } = require('./middleware/roleValidation');
const moment = require('moment')
const { validateDate } = require('./utils')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, roleValidation(['client', 'contractor']), async (req, res) => {
    const { id } = req.params
    let params = { id: id }
    if (req.profile.type == 'client') {
        params.ClientId = req.profile.id
    } else {
        params.ContractorId = req.profile.id
    }
    Contract.findOne({
        where: params
    }).then(contract => {
        if (!contract) {
            res.status(400).json({ message: 'No contract found' });
            return;
        }
        res.json(contract)
    }).catch(err => {
        const error = new BaseError(err);
        res.status(400).json({ message: error.message })
    });

})

/**
 * Returns a list of contracts belonging to a user (client or contractor),
 * the list should only contain non terminated contracts.
 */
app.get('/contracts', getProfile, roleValidation(['client', 'contractor']), async (req, res) => {
    let params = {
        status: {
            [Op.not]: 'terminated'
        }
    }
    if (req.profile.type == 'client') {
        params.ClientId = req.profile.id
    } else {
        params.ContractorId = req.profile.id
    }
    await Contract.findAll({
        where: params
    }).then(contracts => {
        res.json(contracts)
    }).catch(err => {
        const error = new BaseError(err);
        res.status(400).json({ message: error.message })
    });

})

/**
 * Returns all unpaid jobs for a user (***either*** a client or contractor),
 * for ***active contracts only***
 */
app.get('/jobs/unpaid', getProfile, roleValidation(['client', 'contractor']), async (req, res) => {
    let where = { paid: { [Op.not]: true } }
    let include = {
        model: Contract,
        where: { status: 'in_progress' }
    }
    if (req.profile.type == 'client') {
        include.where.ClientId = req.profile.id
    } else {
        include.where.ContractorId = req.profile.id
    }
    Job.findAll({
        where: where,
        include: [include]
    }).then(jobs => {
        res.json(jobs)
    }).catch(err => {
        const error = new BaseError(err);
        res.status(400).json({ message: error.message })
    });
})



/**
 * Pay for a job, a client can only pay if his balance >= the amount to pay.
 * The amount should be moved from the client's balance to the contractor balance
 */
app.post('/jobs/:job_id/pay', getProfile, roleValidation(['client']), async (req, res) => {
    const id = req.params['job_id']
    let params = { id: id }
    let include = [
        {
            model: Contract,
            where: {
                ClientId: req.profile.id,
            },
            include: [{ model: Profile, as: 'Contractor' }]
        },
        { model: Contract, include: [{ model: Profile, as: 'Client' }] }
    ]
    Job.findOne({
        where: params,
        include: include
    }).then(job => {
        let client = job.Contract.Client;
        let contractor = job.Contract.Contractor
        if (!job) {
            res.status(400).json({ message: 'No Job found' })
            return;
        }
        if (job.paid) {
            res.status(400).json({ message: 'Job already paid' })
            return;
        }
        if (job.price > client.balance) {
            res.status(400).json({ message: 'Insufficient funds' })
            return;
        }
        Profile.update({ balance: contractor.balance + job.price }, { where: { id: contractor.id } }).catch(err => {
            const error = new BaseError(err);
            res.status(400).json({ message: error.message })
        });
        Profile.update({ balance: client.balance - job.price }, { where: { id: req.profile.id } }).catch(err => {
            const error = new BaseError(err);
            res.status(400).json({ message: error.message })
        });
        job.update({ paid: true, paymentDate: moment() })
        res.status(200).json({ message: 'Paid successfully' }).end()
    }).catch(err => {
        const error = new BaseError(err);
        res.status(400).json({ message: error.message })
    });
})

/**
 * Deposits money into the the the balance of a client,
 * a client can't deposit more than 25% his total of jobs to pay. (at the deposit moment)
 */
app.post('/balances/deposit/:userId', getProfile, roleValidation(['client']), async (req, res) => {
    const id = req.params['userId']
    Job.findAll({
        where: {
            paid: {
                [Op.not]: true
            },
            depositPaid: {
                [Op.not]: true
            },
        },
        include: [{
            model: Contract,
            as: 'Contract',
            where: {
                ContractorId: id,
                ClientId: req.profile.id,
                status: {
                    [Op.not]: 'terminated'
                }
            },
            include: [{
                model: Profile,
                as: "Client",
            },
            {
                model: Profile,
                as: "Contractor",
            }
            ]
        }]
    }).then(async jobs => {
        if (jobs.length == 0) {
            res.status(400).json({ message: 'No Jobs to pay' })
            return;
        }
        let totalPaid = 0;
        let totalJobsPaid = 0;
        let profile = req.profile
        for (let job of jobs) {
            let contractor = job.Contract.Contractor;
            let depositAmount = ((25 / 100) * job.price)
            if (depositAmount > profile.balance) {
                continue;
            }
            try {
                profile = await Profile.update({ balance: profile.balance - depositAmount }, { where: { id: req.profile.id } })
                contractor = Profile.update({ balance: contractor.balance + depositAmount }, { where: { id: contractor.id } })
                await job.update({ depositPaid: true })
                totalPaid += depositAmount
                totalJobsPaid++;
            } catch (err) {
                const error = new BaseError(err);
                res.status(400).json({ message: error.message })
                return;
            }
        }
        res.status(200).json({ message: 'Deposit paid', jobs: jobs.length, paid: totalPaid, totalJobsPaid: totalJobsPaid });
    }).catch(err => {
        const error = new BaseError(err);
        res.status(400).json({ message: error.message })
    });
})

/**
 * Returns the profession that earned the most money (sum of jobs paid)
 * for any contactor that worked in the query time range.
 */
app.get('/admin/best-profession', getProfile, roleValidation(['admin']), async (req, res) => {

    if (req.query.start && req.query.start) {

        if (!validateDate(req.query.start) || !validateDate(req.query.start)) {
            res.status(400).json({ message: 'Invalid dates, please use the format MM-DD-YYYY' });
            return;
        }
        let start = moment(req.query.start, 'MM-DD-YYYY');
        let end = moment(req.query.end, 'MM-DD-YYYY');
        if (!start.isValid() || !end.isValid()) {
            return res.status(404).end()
        }
        Profile.findAll({
            limit: 1,
            include: [{
                model: Contract,
                as: 'Contractor',
                include: [{
                    model: Job,
                    where: {
                        paymentDate: {
                            [Op.between]: [start, end]
                        },
                        paid: true
                    },
                    attributes: {
                        include: [
                            [sequelize.fn('SUM', sequelize.col('price')), 'price']
                        ]
                    },
                    group: ['profession'],
                    order: [
                        ['price', 'DESC']
                    ],

                }]
            }]

        }).then(profession => {
            if (profession.length == 0) return res.status(404).end()
            res.json({ 'profession': profession[0].profession })
        }).catch(err => {
            const error = new BaseError(err);
            res.status(400).json({ message: error.message })
        });
    } else {
        return res.status(404).end()
    }
})

/**
 * Returns the clients the paid the most for jobs in the query time period.
 * limit query parameter should be applied, default limit is 2
 */
app.get('/admin/best-clients', getProfile, roleValidation(['admin']), async (req, res) => {
    if (req.query.start && req.query.start) {

        if (!validateDate(req.query.start) || !validateDate(req.query.start)) {
            res.status(400).json({ message: 'Invalid dates, please use the format MM-DD-YYYY' });
            return;
        }
        let start = moment(req.query.start, 'MM-DD-YYYY');
        let end = moment(req.query.end, 'MM-DD-YYYY');
        let limit = req.query.limit ? req.query.limit : 2;
        Job.findAll({
            limit: limit,
            attributes: {
                include: [
                    [sequelize.fn('SUM', sequelize.col('price')), 'total']
                ]
            },
            where: {
                paymentDate: {
                    [Op.between]: [start, end]
                },
                paid: true
            },
            group: ['price'],
            order: [
                ['price', 'DESC']
            ],
            include: [{
                model: Contract,
                as: "Contract",
                include: [{
                    model: Profile,
                    as: 'Client',
                }]
            }]
        }).then(jobs => {
            res.json(jobs.map(job => {
                let client = job.dataValues.Contract.dataValues.Client.dataValues
                return {
                    id: client.id,
                    fullName: client.firstName + ' ' + client.lastName,
                    paid: job.dataValues.total
                }
            })).status(200)
        }).catch(err => {
            const error = new BaseError(err);
            res.status(400).json({ message: error.message })
        });
    } else {
        res.status(400).json({ message: 'Start / end dates required' });
    }
})

module.exports = app;