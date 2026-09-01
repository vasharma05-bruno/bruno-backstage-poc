# Bruno Backstage Plugin PRD - Entity

We are going to change the whole architecture of the Bruno Plugin. From a annotation linked collection to an API, we want to remove all of this, and start from scratch. For this I need you to clean up the current implementation of the plugins (both frontend and backend), and start with new architecture.

### Introducing a new Entity Kind: Bruno

We are now going to introduce a new entity kind = `Bruno`. This entity will represent a bruno collection, and a draft structure of the yaml for this entity will be:

```yaml
apiVersion: usebruno/v1alpha1
kind: Bruno
metadata:
  name: string # optional
  version: string # optional
  description: string 

spec:
  type: bruno-collection
  owner: string # Should be optional
  url: string # Git url to the collection folder in a repo
  partOf: string # Reference to an API entity, which creates a relation between Bruno Entity to an API Entity, will be plural
```

### Ingesting Bruno Collection

- A new entity should be ingested according to the above yaml
- The ingestion should check if the folder (available from url) has either a `bruno.json` or an `oxpencollection.yaml` present in it.
- If yes, move ahead with entity generation, else should share an error in the logs.
- Name/ description/ version should be optional, and should be fetched from either of the `bruno.json` or `opencollection.yaml`, and the values in metadata should be used as an override
- Infer information from comments in the yaml

### Creating Bruno entities, other than catalog-info.yaml

The plugin allows a new configuration for creating Bruno Entities

```yaml
# app-config.yaml

bruno:
  collections:
    - type: url
      url: <git url to the Bruno Collection folder>
      partOf: <api-reference to have the `partOf` with> 
```

The ingestion for these collection into entity will be done via the steps mentioned in `Ingesting Bruno Collection`

### Post ingestion

Once the ingestion completes, the OpenCollection.YAML should be generated for the whole collection and must be stored in a similar fashion as the openapi definition is stored.

### Entity Sync

Entity sync should be provided, where the Opencollection.YAML is updated for the said entity, along with other fields, similar to how sync functions in backstage

## UI Flows

Introducing a new entity will also bring a new dashboard for Bruno.

### Bruno Dashboard

- The Bruno Dashboard will be similar to how Backstage renders the API page, which brings in backstage native fetching, filtering, rendering table and more.
- The Bruno Dashbaord will have the title: `Bruno Collections`
- In the starting of the dashboard, we will have the following numerics, as is visible in a dashboard:
  - Number of collections
  - Number of requests
  - Number of unique environments

Rest will remain the same.

### Bruno Entity page

#### Bruno Title Page
Bruno Title, along with existing implementation, must include:
- `version`
- `source url` - git url
- Action buttons
  - Fetch in Bruno - Open Collection in Bruno App with the source url
  - View collection docs - Open the Docs tab in the entity page
- Sync Button

#### Bruno Entity Page Tabs

The Bruno Entity page will have 3 tabs:

- Overview
  - Card: Render the collection documentation from the YAML present
  - Card: List of related API entities in a table, with link to API entity page
    - Each row will have the action button to delete the relation, named: `Unlink`
  - Available Environments in the collection listed in a table (All this information can be interpreted from collection's opencollection.yaml)
- Bruno API Docs
  - This will render the Bruno API Docs inside the tab in an iframe, similar to how it's currently implemented.

### Bruno Card

Every API entity page will display a Bruno Card, which will list the related Bruno Collection Entities in a table format, with an action menu in the end, with following options:
  - Fetch in Bruno
  - View Collection Docs
  - Unlink (danger variant)

Every row will display:
1. Name, linked to Bruno Entity
2. Version
3. Source url
4. Action Menu (as mentioned above)

The card will also have the option to link a new collection to the API, It will open a modal which will either
- Link an already existing bruno entity, OR
- Add a new Bruno Collection button, which will move to the API Dashboard, and start the add new bruno entity flow

### Adding Bruno Collection Entity via UI

There will be a button in the Bruno Dashboard, which will allow adding new Bruno Collection Entity via the UI.

Clicking the button will open a large size modal, where the user will be presented with following fields: 

- an option to provide a Git url, pointing to collection.
  - On entering, scan the link to find a bruno.json/ opencollection.yaml file, and 
    - if not present, display an error, else accept the URL.
- A multiselect displaying a list of API Entities (Check if a backstage native dropdown is available), to add the realtion to the Entity upon creation.
- A submit button

After submission, close the current modal, and open a new modal, where display the `catalog-info.yaml` for the created entity, with helping the user dowloading the generated yaml file. In this modal, we will also provide the way for user to create a PR in the previously submitted folder, to add the said `catalog-info.yaml` file to the git url, similar to how the flow for creating PR exists in the flow for registering new component.

