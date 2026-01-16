# ecommerce-services-demo

This is a demo project of an ecommerce backend system meant to learn Typescript and the Effect ecosystem as well as practice some design patterns like:

1. Distributed Saga
2. Event Outbox
3. Concurrency controls with PostgresQL

The system will have a few components:

1. An Edge API 
    For registering user order requests, getting inital payment authorization from the payment service (the actual payment will be faked) and persisting the request in a ledger for durability.
2. A Payment service
    That will fake payment actions to a 3rd party payment processor and will include randomized failures.
3. An Order Service
    For registering orders against a limited set of products. 
4. A Saga Orchestrator 
    For ensuring that processing an order submission works in a safe way without losing events. 