const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model')
const { Op } = require("sequelize");
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

// EXERCISE 1
/**
 * FIXED, DUDE!
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile , async (req, res) =>{    
    const {Contract} = req.app.get('models')
    const {id} = req.params

    // check the profile type and set the where restriction for the query
    const contractOwner = buildContractOwnerWhere(req.profile.type, req.profile.id)
    const contract = await Contract.findOne({where: {id,... contractOwner}})
    if(!contract) return res.status(404).end()
    res.json(contract)
})

// EXERCISE 2
/**
 * @returns all non terminated contracts belonging to a user
 */
 app.get('/contracts', getProfile , async (req, res) =>{        
    const {Contract} = req.app.get('models')        
    ContractStatus = Contract.getAttributes().status.values //get all possible contratct statuses... find better way to handle with it
    const contractOwner = buildContractOwnerWhere(req.profile.type, req.profile.id)
    const contracts = await Contract.findAll({where: { status : {[Op.ne] : ContractStatus[2] },  ...contractOwner}})
    if(!contracts) return res.status(404).end()
    res.json(contracts)
})

// EXERCISE 3
/**
 * @returns unpaid jobs for a user (only for in_progress contracts)
 */
 app.get('/jobs/unpaid', getProfile , async (req, res) =>{         
    const {Job} = req.app.get('models')    
    const {Contract} = req.app.get('models')       
    const contractOwner = buildContractOwnerWhere(req.profile.type, req.profile.id)
    ContractStatus = Contract.getAttributes().status.values
    const jobs = await Job.findAll({
        where: { paid : null},
        include: [{
            model: Contract,
            where: { status : {[Op.ne] : ContractStatus[2] },  ...contractOwner}
        }]
    })
    if(!jobs) return res.status(404).end()
    res.json(jobs)
})

// EXERCISE 4
/**
 * Assumption:
 * - the client can only pay for his own jobs
 * - the client can only pay for unpaid jobs 
 * - for this transaction, doesn't matter the contract status
 * @returns message with the result of the payment
 */
 app.get('/jobs/:id/pay', getProfile , async (req, res) =>{        
    const {Job} = req.app.get('models')    
    const {Contract} = req.app.get('models')       
    const {Profile} = req.app.get('models')       
    const contractOwner = buildContractOwnerWhere(req.profile.type, req.profile.id)
    const {id} = req.params

    const jobToBePaid = await Job.findOne({
        where: {id},
        include: [{
            model: Contract,
            where: contractOwner,
            include: [
                {
                    model : Profile,
                    as : 'Client'   
                },
                {
                    model : Profile,
                    as : 'Contractor'   
                }
            ]
        }]
    })
    // console.log(jobToBePaid.Contract.Client)
    // //check if the job exists
    if(!jobToBePaid) return res.status(404).end() 
    
    // //check if the job is already paid
    if(jobToBePaid.paid) return res.status(400).json({msg: 'job already paid'}).end()
    
    // //check if the client's balance is enough to pay for the job
    if(jobToBePaid.Contract.Client.balance < jobToBePaid.price) return res.status(400).end({msg: 'client balance is not enough.'})
    
    // start the transaction
    // the rollback will be done automatically if the transaction fails by sequelize (I hope)
    try {        
        const result = await sequelize.transaction(async (t) => {
      
            //update the client's balance
            jobToBePaid.Contract.Client.balance -= jobToBePaid.price;            
            await jobToBePaid.Contract.Client.save({transaction: t});

            //update the contractor balance
            jobToBePaid.Contract.Contractor.balance += jobToBePaid.price;
            await jobToBePaid.Contract.Contractor.save({transaction: t});

            //update the job status and pay date
            jobToBePaid.paid = true;
            jobToBePaid.paymentDate = new Date();
            await jobToBePaid.save({transaction: t});
                     
            return true
        });    
        
        // if the transaction is successful, return the success message
        if(result) return res.status(200).json({msg: 'job paid'}).end()    
        
        // if the transaction is not successful, return the fail message
        } catch (error) {        
           res.json({msg: 'fail when tried to '}).end()
        }          
})

// EXERCISE 5
/**
 * Assumption:
 * - the amount will be passed on the body (amount)
 * @returns message with the result of the deposit
 */
 app.post('/balances/deposit/:id', getProfile , async (req, res) =>{        
    const {Job} = req.app.get('models')       
    const {Contract} = req.app.get('models')           
    const {Profile} = req.app.get('models')           
    const {id} = req.params   
    const contractOwner = buildContractOwnerWhere(req.profile.type, req.profile.id)

    //get amount of upaid jobs
    const totalUnpaidJobs = await Job.findAll({
        where: { paid : null},
        include : [{
            model: Contract,
            where: contractOwner            
        }],        
        attributes: [            
            [sequelize.fn('sum', sequelize.col('price')), 'amount'],
        ],        
        raw: true
    })
    amountUpaidJobs = totalUnpaidJobs[0].amount

    console.log(amountUpaidJobs)
    console.log(req.body)

    //check if the amount to be deposited is lower than 25% of the amount of unpaid jobs
    if (req.body.amount > amountUpaidJobs * 0.25) return res.status(400).json({msg: 'amount is too high'}).end()

    //check if the amount to be deposited is greater than the client's balance
    if(req.profile.balance < req.body.amount) return res.status(400).json({msg: 'balance is not enough'}).end()

    //start the transaction    
    try {        
        const result = await sequelize.transaction(async (t) => {
            //load the client
            client = await Profile.findOne({where: {id: id}, transaction: t})

            //update the client's balance
            client.balance += req.body.amount;
            await client.save({transaction: t});                        
            return true
        });    
                
    if(result) return res.status(200).json({msg: 'amount deposited'}).end()    
    
    // if the transaction is not successful, return the fail message
    } catch (error) {        
        res.json({msg: 'fail when tried to deposit the amount'}).end()
    }          
})

// EXERCISE 6
/* Assumptions
 * - contractors that worked in the data range = contractors with jobs created in the data range
 * @returns the profession that earned the most money 
 */
 app.get('/admin/best-profession', getProfile ,async (req, res) =>{            
    const {Job} = req.app.get('models')  
    const {Contract} = req.app.get('models')           
    const {Profile} = req.app.get('models')           
         
    const {start} = req.query
    const {end} = req.query
    
    //get amount of upaid jobs
    const totalPaidJobs = await Job.findAll({
        where: { 
            paid : true,
            paymentDate: {
                [Op.between]: [new Date(start * 1000),new Date(end * 1000)]
            }
        },        
        include : [{            
            model: Contract,                   
            include: [                
                {
                    model : Profile,
                    as : 'Contractor',
                    where : {
                        type : 'contractor'
                    },
                    attributes: ['profession']
                }
            ]
        }],
        attributes: [             
            'ContractId',            
            [sequelize.fn('sum', sequelize.col('price')), 'amount'],
        ],       
        group : ['Contract.Contractor.profession'],
        order : sequelize.literal('amount DESC'),        
    })

    // case there are no jobs
    if (totalPaidJobs.length == 0) return res.status(404).end()

    // return the profession
    res.json(totalPaidJobs[0].Contract.Contractor.profession).end()
})

// EXERCISE 7
/*
 * @returns the clients the paid the most for jobs
 */
app.get('/admin/best-clients', getProfile ,async (req, res) =>{            
    const {Job} = req.app.get('models')  
    const {Contract} = req.app.get('models')           
    const {Profile} = req.app.get('models')           
         
    const {start} = req.query
    const {end} = req.query
    
    //get amount of upaid jobs
    const totalPaidJobs = await Job.findAll({
        where: { 
            paid : true,
            paymentDate: {
                [Op.between]: [new Date(start * 1000),new Date(end * 1000)]
            }
        },        
        include : [{            
            model: Contract,                   
            include: [                
                {
                    model : Profile,
                    as : 'Client',
                    where : {
                        type : 'client'
                    },                 
                    
                }
            ]
        }],
        attributes: [             
            'ContractId',            
            [sequelize.fn('sum', sequelize.col('price')), 'amount'],
        ],       
        group : ['Contract.Client.id'],
        order : sequelize.literal('amount DESC'),        
    })
    
    if (totalPaidJobs.length == 0) return res.status(404).end()

    // return the profession
    res.json(
        totalPaidJobs.map( (j) => {            
            return {
                amount : j.dataValues.amount,
                name : `${j.Contract.Client.firstName} ${j.Contract.Client.lastName}`,
                id : j.Contract.Client.id
            }
    })).end()
})






 app.get('/profiles',getProfile ,async (req, res) =>{    
    const {Profile} = req.app.get('models')
    const profiles = await Profile.findAll()
    if(!profiles) return res.status(404).end()
    res.json(profiles)
})

app.get('/jobs',getProfile ,async (req, res) =>{        
    const {Job} = req.app.get('models')    
    const {Contract} = req.app.get('models')       
    const contractOwner = buildContractOwnerWhere(req.profile.type, req.profile.id)
    ContractStatus = Contract.getAttributes().status.values
    const jobs = await Job.findAll({              
        include: [{
            model: Contract,
            where: contractOwner
        }]
    })
    if(!jobs) return res.status(404).end()
    res.json(jobs)
})


/**
 * @returns the where clause for the contract owner according to the profile type
 */
buildContractOwnerWhere = (type, id) => type == 'client' ? {ClientId : id} : {ContractorId : id}

module.exports = app;
