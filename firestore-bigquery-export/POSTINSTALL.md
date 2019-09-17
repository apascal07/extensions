### See it in action

You can test out this extension right away:

1.  Go to your [Cloud Firestore dashboard](https://console.firebase.google.com/project/${param:PROJECT_ID}/database/firestore/data).

1.  If it doesn't already exist, create the collection you specified during installation: `${param:COLLECTION_PATH}`.

1.  Create a document in the collection called `bigquery-mirror-test` that contains any fields with any values that you'd like.

1.  Go to the [BigQuery web UI](https://console.cloud.google.com/bigquery?project=${param:PROJECT_ID}&p=${param:PROJECT_ID}&d=${param:DATASET_ID}) in the Google Cloud Platform console.

1.  Query your **raw changelog table**, which should contain a single log of creating the `bigquery-mirror-test` document.

    ```  
    SELECT * FROM `${param:PROJECT_ID}.${param:DATASET_ID}.${param:COLLECTION_PATH}_raw_changelog`   
    ```

1.  Query your **latest view**, which should return the latest change event for the only document present -- `bigquery-mirror-test`.

    ```  
    SELECT * FROM `${param:PROJECT_ID}.${param:DATASET_ID}.${param:COLLECTION_PATH}_raw_latest`
    ```

1.  Delete the `bigquery-mirror-test` document from [Cloud Firestore](https://console.firebase.google.com/project/${param:PROJECT_ID}/database/firestore/data).  
The `bigquery-mirror-test` document will disappear from the **latest view** and a `DELETE` event will be added to the **raw changelog table**.

1.  You can check the changelogs of a single document with this query:

    ```  
    SELECT * FROM `${param:PROJECT_ID}.${param:DATASET_ID}.${param:COLLECTION_PATH}_raw_changelog` 
       WHERE document_name = "bigquery-mirror-test" 
       ORDER BY TIMESTAMP ASC  
    ```

### Using the extension

Whenever a document is created, updated, imported, or deleted in the specified collection, this extension sends that update to BigQuery. You can then run queries on this mirrored dataset which contains the following resources:

+   **raw changelog table:** [`${param:DATASET_ID}_raw_changelog`](https://console.cloud.google.com/bigquery?project=${param:PROJECT_ID}&p=${param:PROJECT_ID}&d=${param:DATASET_ID}&t=${param:COLLECTION_PATH}_raw_changelog&page=table)
+   **latest view:** [`${param:DATASET_ID}_raw_latest`](https://console.cloud.google.com/bigquery?project=${param:PROJECT_ID}&p=${param:PROJECT_ID}&d=${param:DATASET_ID}&t=${param:COLLECTION_PATH}_raw_latest&page=table)

To review the schema for these two resources, click the **Schema** tab for each resource in BigQuery.

Note that this extension only listens for _document_ changes in the collection, but not changes in any _subcollection_. You can, though, install additional instances of this extension to specifically listen to a subcollection or other collections in your database.

### _(Optional)_ Import existing documents

This extension only sends the content of documents that have been changed -- it does not export your full dataset of existing documents into BigQuery. So, to backfill your BigQuery dataset with all the documents in your collection, you can run the import script provided by this extension.

The import script can read all existing documents in a Cloud Firestore collection and insert them into the raw changelog table created by this extension. The script adds a special changelog for each document with the operation of `IMPORT` and the timestamp of epoch. This is to ensure that any operation on an imported document supersedes the `IMPORT`

**Important:** Run the script over the entire collection _after_ installing this extension, otherwise all writes to your database during the import might be lost.

You may pause and resume the script from the last batch at any point.

Learn more about using this script to [backfill your existing collection](https://dev-partners.googlesource.com/samples/firebase/mods/+/master/firestore-bigquery-export/guides/IMPORT_EXISTING_DOCUMENTS.md).

### Monitoring

As a best practice, you can [monitor the activity](https://firebase.google.com/docs/extensions/manage-installed-extensions#monitor) of your installed extension, including checks on its health, usage, and logs.